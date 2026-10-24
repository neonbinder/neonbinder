/**
 * NEO-350 / NEO-359 — My Binders, the pure half: what goes on each page of an
 * open binder, box, pile or browsed set, where a card lives, share links, the
 * Browse shelf's filters, and the one-match guard for a typed card.
 *
 * Everything here reads the collection's view model (`../data/types`), so the
 * demo and the real collection lay out the same way. Nothing keys behaviour
 * on a display name: system containers are recognised by `system`, rules
 * name ids, and a name only ever becomes a slug for a link the collector can
 * read.
 *
 * A copy's pocket or row is its `slot` (NEO-359): a binder pocket is
 * `page * 9 + pocket`, a box row is 0 to 4. A binder no longer stores pages;
 * they follow from the slots its copies hold.
 */

import { cardLabel, compareCards, playerNames, setLabel, variantLabel } from "../data/labels";
import {
  BOX_ROWS,
  POCKETS_PER_PAGE,
  pocketOf,
  pocketSlot,
  type Card,
  type CardId,
  type Container,
  type ContainerId,
  type ContainerRule,
  type Copy,
  type SetRef,
  type TeamId,
  type Want,
} from "../data/types";
import type { BrowseFilter } from "../store";

// ---------------------------------------------------------------------------
// Views and pockets
// ---------------------------------------------------------------------------

/**
 * What is open on the desk: everything, one binder or box (or the Want List,
 * the trade pile, a smart binder), a set to browse, or every for-sale copy
 * at once (the Inventory long box on real data).
 */
export type ViewKey =
  | { kind: "all" }
  | { kind: "binder"; binderId: ContainerId }
  | { kind: "set"; setId: string }
  | { kind: "sale" };

/** "Lay out like my real binder" or "Just a stack". */
export type LayoutMode = "pockets" | "stack";

export type SortKey = "checklist" | "newest" | "player";

export interface PileFilters {
  graded: boolean;
  forSale: boolean;
  rookies: boolean;
}

export const NO_FILTERS: PileFilters = { graded: false, forSale: false, rookies: false };

/** A real pocket in a binder: where a drop or a pick lands. `slot` is the pocket on its page (0-8). */
export interface SlotRef {
  binderId: ContainerId;
  page: number;
  slot: number;
}

export type PocketContent =
  /** Owned: one copy (a per-copy pocket) or every copy of the card. */
  | { kind: "have"; card: Card; copies: Copy[] }
  /** A card the view wants and the collector does not have yet. */
  | { kind: "need"; card: Card }
  | { kind: "empty" };

export interface PocketModel {
  content: PocketContent;
  slot?: SlotRef;
  /** On the Want List: the binder or box the want is for (null: none). */
  wantFor?: ContainerId | null;
}

export interface PageModel {
  pockets: PocketModel[];
  /** The checklist section the page belongs to ("Base", "Pennant Flyers"). */
  section: string | null;
  /** Pages past the binder's pockets ("Not in a pocket yet"). */
  note?: string;
}

const EMPTY: PocketModel = { content: { kind: "empty" } };

/** Chop pockets into pages of nine, padding the last with empty sleeves. */
export function paginate(pockets: PocketModel[], section: string | null, note?: string): PageModel[] {
  const pages: PageModel[] = [];
  for (let i = 0; i < pockets.length; i += POCKETS_PER_PAGE) {
    const chunk = pockets.slice(i, i + POCKETS_PER_PAGE);
    while (chunk.length < POCKETS_PER_PAGE) chunk.push(EMPTY);
    pages.push(note ? { pockets: chunk, section, note } : { pockets: chunk, section });
  }
  return pages;
}

/** The pocket a binder slot names. */
export function slotRefOf(binderId: ContainerId, slot: number): SlotRef {
  const { page, pocket } = pocketOf(slot);
  return { binderId, page, slot: pocket };
}

/** The slot number of a pocket. */
export function slotOf(ref: Pick<SlotRef, "page" | "slot">): number {
  return pocketSlot(ref.page, ref.slot);
}

export function sameSlot(a: SlotRef | null | undefined, b: SlotRef | null | undefined): boolean {
  return !!a && !!b && a.binderId === b.binderId && a.page === b.page && a.slot === b.slot;
}

/** Every card on the pages, in order, once: what the drawer's ↑ ↓ step through. */
export function cardsOnPages(pages: PageModel[]): CardId[] {
  const seen = new Set<CardId>();
  for (const page of pages) {
    for (const { content } of page.pockets) {
      if (content.kind !== "empty") seen.add(content.card.id);
    }
  }
  return [...seen];
}

/** The checklist section a card files under: each insert alone, parallels together. */
export function sectionOf(card: Card): string {
  if (card.variant.kind === "base") return "Base";
  if (card.variant.kind === "parallel") return "Parallels";
  return variantLabel(card.variant);
}

/** Cards in checklist order, a fresh run of pages for each section. */
function sectionedPages(cards: Card[], toPocket: (c: Card) => PocketModel): PageModel[] {
  const pages: PageModel[] = [];
  let run: Card[] = [];
  let current: string | null = null;
  const flush = () => {
    if (run.length) pages.push(...paginate(run.map(toPocket), current));
    run = [];
  };
  for (const card of cards) {
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

/** Look a copy's card up; a copy whose card is gone (or still loading) has no pocket. */
export type CardsById = ReadonlyMap<CardId, Card>;

function perCopy(copies: readonly Copy[], cards: CardsById): PocketModel[] {
  const out: PocketModel[] = [];
  for (const copy of copies) {
    const card = cards.get(copy.cardId);
    if (card) out.push({ content: { kind: "have", card, copies: [copy] } });
  }
  return out;
}

function byChecklist(cards: CardsById) {
  return (a: Copy, b: Copy) => {
    const ca = cards.get(a.cardId);
    const cb = cards.get(b.cardId);
    if (!ca || !cb) return ca ? -1 : cb ? 1 : 0;
    return compareCards(ca, cb);
  };
}

/** "Just a stack": one pocket per copy, packed tight, in checklist order. */
export function stackPages(copies: readonly Copy[], cards: CardsById): PageModel[] {
  return paginate(perCopy([...copies].sort(byChecklist(cards)), cards), null);
}

/** One pocket per card (every copy of it together), in checklist order: a smart binder laid out. */
export function cardPages(copies: readonly Copy[], cards: CardsById): PageModel[] {
  const byCard = new Map<CardId, Copy[]>();
  for (const copy of copies) {
    const list = byCard.get(copy.cardId);
    if (list) list.push(copy);
    else byCard.set(copy.cardId, [copy]);
  }
  const owned = [...byCard.entries()]
    .map(([id, list]) => ({ card: cards.get(id), list }))
    .filter((e): e is { card: Card; list: Copy[] } => !!e.card)
    .sort((a, b) => compareCards(a.card, b.card));
  return paginate(
    owned.map(({ card, list }) => ({ content: { kind: "have", card, copies: list } })),
    null,
  );
}

// ---------------------------------------------------------------------------
// All my cards: the master pile
// ---------------------------------------------------------------------------

function lastName(card: Card): string {
  const words = (card.players[0]?.name ?? "")
    .split(/\s+/)
    .filter((w) => w && !/^(jr\.?|sr\.?|ii|iii|iv)$/i.test(w));
  return words[words.length - 1] ?? "";
}

/** Every copy, one pocket each, filtered and sorted as the pile's tools say. */
export function pilePages(
  copies: readonly Copy[],
  cards: CardsById,
  sort: SortKey,
  filters: PileFilters,
): PageModel[] {
  const kept = copies.filter((c) => {
    if (c.quantity < 1) return false;
    if (filters.graded && !c.graded) return false;
    if (filters.forSale && c.homeKind !== "box") return false;
    if (filters.rookies && !cards.get(c.cardId)?.features.includes("RC")) return false;
    return true;
  });
  const checklist = byChecklist(cards);
  const sorted = [...kept].sort((a, b) => {
    if (sort === "newest") return b.acquiredAt.localeCompare(a.acquiredAt) || checklist(a, b);
    if (sort === "player") {
      const ca = cards.get(a.cardId);
      const cb = cards.get(b.cardId);
      return (ca && cb ? lastName(ca).localeCompare(lastName(cb)) : 0) || checklist(a, b);
    }
    return checklist(a, b);
  });
  return paginate(perCopy(sorted, cards), null);
}

// ---------------------------------------------------------------------------
// A binder laid out like the real one
// ---------------------------------------------------------------------------
//
// The numbered pages are the checklist (pocket N holds card N) when the
// binder follows one; everything after them is "Extras": a second copy, a
// stray card. Extras never count against the checklist, and nothing is ever
// slotted into another card's numbered pocket.

export const EXTRAS = "Extras";

/** Where the Extras pages start: the first pocket after the checklist's last page. */
export function extrasStart(checklist: readonly Card[]): number {
  return Math.ceil(checklist.length / POCKETS_PER_PAGE) * POCKETS_PER_PAGE;
}

/** The copies of a binder that sit in a pocket, by slot. */
export function pocketsOf(copies: readonly Copy[]): Map<number, Copy> {
  const out = new Map<number, Copy>();
  for (const copy of copies) {
    if (copy.slot !== undefined && copy.slot >= 0 && !out.has(copy.slot)) out.set(copy.slot, copy);
  }
  return out;
}

/**
 * The checklist whose variant the first filled pocket names: the one a
 * binder MIGHT follow (`followedChecklist` decides). Null with no pockets.
 */
export function firstPocketVariant(copies: readonly Copy[]): string | null {
  const pockets = [...pocketsOf(copies).entries()].sort((a, b) => a[0] - b[0]);
  return pockets[0]?.[1].variantId ?? null;
}

/**
 * The checklist a binder's numbered pockets follow, or null. Decided from
 * ids every time, never stored: `checklist` is the variant the first filled
 * pocket names (regular cards only, in checklist order), and every filled
 * pocket inside it must hold card N in pocket N, with at least three filled.
 */
export function followedChecklist(copies: readonly Copy[], checklist: readonly Card[] | undefined): Card[] | null {
  if (!checklist || checklist.length === 0) return null;
  const regular = checklist.filter((c) => !c.isVariation);
  const filled = [...pocketsOf(copies).entries()].filter(([slot]) => slot < regular.length);
  if (filled.length < 3) return null;
  return filled.every(([slot, copy]) => regular[slot]?.id === copy.cardId) ? regular : null;
}

/**
 * A binder's pages in pockets mode: its own pockets in slot order, a fresh
 * page at the back, then the copies filed here but in no pocket yet. With a
 * followed checklist, empty numbered pockets are Need sleeves (when the
 * collector has the card nowhere: `ownedAnywhere`) and the pages past the
 * checklist say "Extras".
 */
export function binderPages(input: {
  binderId: ContainerId;
  copies: readonly Copy[];
  cards: CardsById;
  followed: readonly Card[] | null;
  ownedAnywhere?: (cardId: CardId) => boolean;
}): PageModel[] {
  const { binderId, copies, cards, followed } = input;
  const owned = input.ownedAnywhere ?? (() => false);
  const pockets = pocketsOf(copies);
  const maxSlot = Math.max(-1, ...pockets.keys());
  const used = Math.max(maxSlot + 1, followed ? extrasStart(followed) : 0);
  const pageCount = Math.ceil(used / POCKETS_PER_PAGE);
  const checklistPages = followed ? extrasStart(followed) / POCKETS_PER_PAGE : 0;
  const sectionFor = (p: number) => (followed ? (p < checklistPages ? sectionOf(followed[0]) : EXTRAS) : null);

  const pages: PageModel[] = [];
  for (let p = 0; p < pageCount; p++) {
    const page: PocketModel[] = [];
    for (let s = 0; s < POCKETS_PER_PAGE; s++) {
      const n = pocketSlot(p, s);
      const slot = slotRefOf(binderId, n);
      const copy = pockets.get(n);
      const card = copy ? cards.get(copy.cardId) : undefined;
      if (copy && card) {
        page.push({ slot, content: { kind: "have", card, copies: [copy] } });
        continue;
      }
      const wanted = followed?.[n];
      if (!copy && wanted && !owned(wanted.id)) page.push({ slot, content: { kind: "need", card: wanted } });
      else page.push({ slot, content: { kind: "empty" } });
    }
    pages.push({ section: sectionFor(p), pockets: page });
  }

  // A fresh page at the back, unless the last one is still blank.
  const last = pages[pages.length - 1];
  if (!last || last.pockets.some((pk) => pk.content.kind !== "empty")) {
    const p = pages.length;
    pages.push({
      section: followed && p >= checklistPages ? EXTRAS : null,
      note: followed ? undefined : "A fresh page",
      pockets: Array.from({ length: POCKETS_PER_PAGE }, (_, s) => ({
        slot: slotRefOf(binderId, pocketSlot(p, s)),
        content: { kind: "empty" as const },
      })),
    });
  }

  // Filed in the binder but in no pocket yet (a copy from its details, or a move).
  const pocketed = new Set([...pockets.values()].map((c) => c.id));
  const loose = copies.filter((c) => !pocketed.has(c.id)).sort(byChecklist(cards));
  if (loose.length) pages.push(...paginate(perCopy(loose, cards), null, "Not in a pocket yet"));
  return pages;
}

/** Have / need on a followed checklist, for the cover. */
export function followedTally(
  copies: readonly Copy[],
  followed: readonly Card[],
  ownedAnywhere: (cardId: CardId) => boolean,
): { have: number; need: number } {
  const here = new Set(copies.map((c) => c.cardId));
  const have = followed.filter((c) => here.has(c.id) || ownedAnywhere(c.id)).length;
  return { have, need: followed.length - have };
}

/**
 * Where a card goes when the collector says "put it in this binder": its
 * own numbered pocket when the binder follows a checklist and that pocket is
 * free; otherwise (a second copy, or a card from another set) the first free
 * pocket on the Extras pages. A binder with no checklist takes the first
 * free pocket anywhere. A full binder grows a page.
 */
export function pocketFor(copies: readonly Copy[], card: Card, followed: readonly Card[] | null): number {
  const taken = pocketsOf(copies);
  if (followed) {
    const own = followed.findIndex((c) => c.id === card.id);
    if (own !== -1 && !taken.has(own)) return own;
    let i = extrasStart(followed);
    while (taken.has(i)) i++;
    return i;
  }
  let i = 0;
  while (taken.has(i)) i++;
  return i;
}

/**
 * A pocket the collector aimed at or dropped on. Inside a checklist's
 * numbered pages, pocket N is saved for card N: any other card is sent to
 * its own pocket or the Extras pages instead, and `savedFor` says why.
 */
export function guardPocket(
  copies: readonly Copy[],
  slot: number,
  card: Card,
  followed: readonly Card[] | null,
): { slot: number; savedFor: Card | null } {
  if (!followed || slot >= followed.length || followed[slot].id === card.id) return { slot, savedFor: null };
  return { slot: pocketFor(copies, card, followed), savedFor: followed[slot] };
}

// ---------------------------------------------------------------------------
// A browsed set
// ---------------------------------------------------------------------------

/**
 * A set flipped through: every card in set order. Laid out, each section
 * starts a fresh page; as a stack, packed tight. A card whose copies are not
 * in yet reads as a need until they are.
 */
export function setPages(
  cards: readonly Card[],
  copiesByCard: Readonly<Record<CardId, Copy[]>> | undefined,
  mode: LayoutMode,
): PageModel[] {
  const toPocket = (card: Card): PocketModel => {
    const mine = (copiesByCard?.[card.id] ?? []).filter((c) => c.quantity > 0);
    return { content: mine.length ? { kind: "have", card, copies: mine } : { kind: "need", card } };
  };
  if (mode === "stack") return paginate(cards.map(toPocket), null);
  return sectionedPages([...cards], toPocket);
}

// ---------------------------------------------------------------------------
// The Want List
// ---------------------------------------------------------------------------

/** The section heading over a group of wants. */
export function wantSection(binderId: ContainerId | null, nameOf: (id: ContainerId) => string | undefined): string {
  if (binderId === null) return "Just want it";
  return `For ${nameOf(binderId) ?? "a binder"}`;
}

/**
 * The Want List, opened: plain wants first, then one group per binder or box
 * in shelf order, each starting a fresh page like a new section of a real
 * binder, cards in checklist order. A want you have since landed shows the
 * card in its sleeve; the rest are "Need" sleeves.
 */
export function wantPages(input: {
  wants: readonly Want[];
  containers: readonly Container[];
  cards: CardsById;
  copiesByCard: Readonly<Record<CardId, Copy[]>> | undefined;
}): PageModel[] {
  const { wants, containers, cards, copiesByCard } = input;
  const order = new Map(containers.map((c, i) => [c.id, i]));
  const groups = new Map<ContainerId | null, Card[]>();
  for (const w of wants) {
    const card = cards.get(w.cardId);
    if (!card) continue;
    const key = w.binderId !== null && order.has(w.binderId) ? w.binderId : null;
    const list = groups.get(key);
    if (list) list.push(card);
    else groups.set(key, [card]);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    a === null ? -1 : b === null ? 1 : (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );
  const nameOf = (id: ContainerId) => containers.find((c) => c.id === id)?.name;
  const pages: PageModel[] = [];
  for (const key of keys) {
    const list = [...(groups.get(key) ?? [])].sort(compareCards);
    const pockets = list.map((card): PocketModel => {
      const mine = (copiesByCard?.[card.id] ?? []).filter((c) => c.quantity > 0);
      return {
        content: mine.length ? { kind: "have", card, copies: mine } : { kind: "need", card },
        wantFor: key,
      };
    });
    pages.push(...paginate(pockets, wantSection(key, nameOf)));
  }
  return pages;
}

// ---------------------------------------------------------------------------
// A box's rows
// ---------------------------------------------------------------------------

export interface BoxRows {
  /** `BOX_ROWS` rows, front to back: the copies whose slot is that row. */
  rows: Copy[][];
  /** In the box, in no row yet. */
  unsorted: Copy[];
}

/** A box's copies by row, each row in checklist order. */
export function boxRows(copies: readonly Copy[], cards: CardsById): BoxRows {
  const rows: Copy[][] = Array.from({ length: BOX_ROWS }, () => []);
  const unsorted: Copy[] = [];
  for (const copy of copies) {
    if (copy.slot !== undefined && copy.slot >= 0 && copy.slot < BOX_ROWS) rows[copy.slot].push(copy);
    else unsorted.push(copy);
  }
  const order = byChecklist(cards);
  return { rows: rows.map((r) => r.sort(order)), unsorted: unsorted.sort(order) };
}

/** "Row 1" to "Row 5": a box row as the collector counts it. */
export function rowName(row: number): string {
  return `Row ${row + 1}`;
}

// ---------------------------------------------------------------------------
// Where a card lives (the hunt tray)
// ---------------------------------------------------------------------------

/** One place a card lives: a home, and its pocket or row when it sits in one. */
export interface Place {
  homeId: ContainerId;
  homeName: string;
  /** The home is a box: the card is for sale there. */
  box: boolean;
  /** A binder pocket, or null. */
  pocket: { page: number; slot: number } | null;
  /** A box row (0-4), or null. */
  row: number | null;
  /** The line items in this place (one, for a pocket). */
  copyIds: string[];
  /** Cards in this place, counting a line item's quantity. */
  quantity: number;
}

/**
 * Every place the collector's copies of a card live, home by home in shelf
 * order. A copy in a binder pocket is its own place ("'96 Contenders, page
 * 2, pocket 4"); copies in one box row share it ("Show box, row 2"); copies
 * just filed somewhere share one ("Main ×2").
 */
export function placesOf(copies: readonly Copy[], containers: readonly Container[]): Place[] {
  const order = new Map(containers.map((c, i) => [c.id, i]));
  const homes = [...new Set(copies.map((c) => c.homeId))].sort(
    (a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity),
  );
  const places: Place[] = [];
  for (const homeId of homes) {
    const home = containers.find((c) => c.id === homeId);
    const here = copies.filter((c) => c.homeId === homeId && c.quantity > 0);
    if (here.length === 0) continue;
    const box = (home?.kind ?? here[0].homeKind) === "box";
    const homeName = home?.name ?? here[0].homeName ?? "a binder";
    const base = { homeId, homeName, box };
    const pocketed: Place[] = [];
    const rows = new Map<number, Copy[]>();
    const loose: Copy[] = [];
    for (const copy of here) {
      if (copy.slot === undefined || copy.slot < 0) loose.push(copy);
      else if (box) {
        if (copy.slot < BOX_ROWS) rows.set(copy.slot, [...(rows.get(copy.slot) ?? []), copy]);
        else loose.push(copy);
      } else {
        const { page, pocket } = pocketOf(copy.slot);
        pocketed.push({ ...base, pocket: { page, slot: pocket }, row: null, copyIds: [copy.id], quantity: copy.quantity });
      }
    }
    pocketed.sort((a, b) => a.pocket!.page - b.pocket!.page || a.pocket!.slot - b.pocket!.slot);
    places.push(...pocketed);
    for (const [row, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      places.push({
        ...base,
        pocket: null,
        row,
        copyIds: list.map((c) => c.id),
        quantity: list.reduce((n, c) => n + c.quantity, 0),
      });
    }
    if (loose.length) {
      places.push({
        ...base,
        pocket: null,
        row: null,
        copyIds: loose.map((c) => c.id),
        quantity: loose.reduce((n, c) => n + c.quantity, 0),
      });
    }
  }
  return places;
}

/** "'96 Contenders, page 2, pocket 4", "Show box, row 2", "Main ×2". */
export function placeWords(place: Place): string {
  if (place.pocket) return `${place.homeName}, page ${place.pocket.page + 1}, pocket ${place.pocket.slot + 1}`;
  const qty = place.quantity > 1 ? ` ×${place.quantity}` : "";
  if (place.row !== null) return `${place.homeName}, row ${place.row + 1}${qty}`;
  return `${place.homeName}${qty}`;
}

/** The copies of a card that "Move here" may move into `to`: any not already there. */
export function movableCopies(copies: readonly Copy[], to: ContainerId): Copy[] {
  return copies.filter((c) => c.homeId !== to && c.quantity > 0);
}

/** The copies of a card "Put up for trade" may flag: any not flagged yet. */
export function tradeableCopies(copies: readonly Copy[]): Copy[] {
  return copies.filter((c) => !c.upForTrade && c.quantity > 0);
}

// ---------------------------------------------------------------------------
// A typed card: act only on exactly one match
// ---------------------------------------------------------------------------

export type TypedCard =
  | { kind: "none" }
  | { kind: "one"; card: Card }
  /** More than one card fits: the collector picks. Never the first. */
  | { kind: "many"; count: number };

/**
 * What Enter in the hunt may act on. A card number is not unique (a set has
 * #1 in Base and #1 in every parallel), so a search only resolves to a card
 * when exactly one card fits every word.
 */
export function resolveTyped(hits: readonly Card[], truncated = false): TypedCard {
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1 && !truncated) return { kind: "one", card: hits[0] };
  return { kind: "many", count: hits.length };
}

/** The copy a per-copy pocket holds, so the drawer can ring its line item. */
export function soleCopyId(copies: readonly Copy[]): string | undefined {
  return copies.length === 1 ? copies[0].id : undefined;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "#4 Reggie White", "Pennant Flyers #2 Reggie White", "Gold Refractor #1 Shohei Ohtani". */
export function shortName(card: Card): string {
  const variant = card.variant.kind === "base" ? "" : `${variantLabel(card.variant)} `;
  const players = playerNames(card);
  const variation = card.cardVariation ? ` (${card.cardVariation})` : "";
  return `${variant}#${card.cardNumber}${players ? ` ${players}` : ""}${variation}`;
}

/** "PSA 9", or null for a raw copy. */
export function slabLabel(copy: Pick<Copy, "graded">): string | null {
  return copy.graded ? `${copy.graded.grader} ${copy.graded.grade}`.trim() : null;
}

/** A pocket's accessible name for an owned card. */
export function havePocketLabel(card: Card, copies: readonly Copy[]): string {
  const qty = copies.reduce((n, c) => n + c.quantity, 0);
  const parts = [cardLabel(card)];
  if (qty > 1) parts.push(`${qty} copies`);
  if (copies.length === 1) {
    const slab = slabLabel(copies[0]);
    if (slab) parts.push(slab);
    if (copies[0].serialNumber) parts.push(`serial ${copies[0].serialNumber}`);
  }
  if (copies.some((c) => c.homeKind === "box")) parts.push("for sale");
  if (copies.some((c) => c.upForTrade)) parts.push("up for trade");
  return parts.join(", ");
}

/** "12 cards", "1 card". */
export function cardCount(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "card" : "cards"}`;
}

// ---------------------------------------------------------------------------
// The smart binder's team rule
// ---------------------------------------------------------------------------

/**
 * "A team" means cards showing the team, in that jersey. Ticking "Also count
 * anyone who played for them" widens it to the team's alumni as well.
 */
export function teamRule(teamId: TeamId, alsoPlayedFor: boolean): ContainerRule {
  return alsoPlayedFor
    ? { kind: "or", rules: [{ kind: "teamOnCard", teamId }, { kind: "playedFor", teamId }] }
    : { kind: "teamOnCard", teamId };
}

// ---------------------------------------------------------------------------
// Share links (mock: no such route yet; capability `share`)
// ---------------------------------------------------------------------------

/**
 * The share links' handle. Share is demo-only, so the handle is anyone's,
 * never a real collector's, and the link reads as an example.
 */
export const DEMO_HANDLE = "you";

/** "'96 Contenders" -> "96-contenders", "Ohtani rainbow" -> "ohtani-rainbow". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "binder";
}

/** What a Share button shares: its name in words, and its path after the handle. */
export interface ShareTarget {
  /** "Ohtani rainbow", "your Want List", "2000 Topps". */
  what: string;
  /** "binders/ohtani-rainbow", "want-list", "sets/2000-topps". */
  path: string;
}

export function containerShareTarget(container: Pick<Container, "name" | "system" | "kind">): ShareTarget {
  if (container.system === "want") return { what: "your Want List", path: "want-list" };
  const dir = container.kind === "box" ? "boxes" : "binders";
  return { what: container.name, path: `${dir}/${slugify(container.name)}` };
}

/** A set you are flipping through: your copy of its checklist. */
export function setShareTarget(set: Pick<SetRef, "season" | "name">): ShareTarget {
  return { what: setLabel(set), path: `sets/${slugify(setLabel(set))}` };
}

/** The human-readable public link for a share target. */
export function shareUrl(target: ShareTarget, handle = DEMO_HANDLE): string {
  return `neonbinder.io/@${handle}/${target.path}`;
}

// ---------------------------------------------------------------------------
// Browse a set: the shelf's filters (the demo's catalog)
// ---------------------------------------------------------------------------

function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The sets the Browse shelf shows: one sport (or all), a year range (either
 * end open, ends inclusive and swapped if typed backwards) and every word of
 * the name typed ("96 contenders", "chrome").
 */
export function filterSets(sets: readonly SetRef[], filter: BrowseFilter): SetRef[] {
  let { from, to } = filter;
  if (from !== null && to !== null && from > to) [from, to] = [to, from];
  const words = foldText(filter.q).split(" ").filter(Boolean);
  return sets.filter((set) => {
    if (filter.sport !== "all" && set.sport.id !== filter.sport) return false;
    if (from !== null && set.year < from) return false;
    if (to !== null && set.year > to) return false;
    if (words.length === 0) return true;
    const label = foldText(setLabel(set));
    return words.every((w) => label.includes(w));
  });
}

/** True when any filter is narrowing the shelf. */
export function isFiltering(filter: BrowseFilter): boolean {
  return filter.sport !== "all" || filter.from !== null || filter.to !== null || filter.q.trim() !== "";
}

/** The sports on the Browse shelf, in shelf order, once each. */
export function sportsOf(sets: readonly SetRef[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const s of sets) if (!seen.has(s.sport.id)) seen.set(s.sport.id, s.sport.name);
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}
