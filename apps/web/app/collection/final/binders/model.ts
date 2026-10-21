/**
 * NEO-350 — My Binders (prototype 2, Nine-Pocket, on the consolidated page):
 * the pure half on top of p2's model. Adds what the consolidated page needs
 * and p2 never had: the special shelf's liveries, the Want List's pages,
 * share links, the smart binder's team rule, and the one-match guard for a
 * typed card.
 *
 * Nothing here keys on a display name to decide behaviour: system binders are
 * recognised by `binder.system`, rules name ids, and a name only ever becomes
 * a slug for a link the collector can read.
 */

import {
  binderCopies,
  cardsInSet,
  compareCards,
  copiesOf,
  getCard,
  setLabel,
  type Binder,
  type BinderId,
  type BinderRule,
  type Card,
  type CardSet,
  type Copy,
  type ManualBinder,
  type SearchHit,
  type TeamId,
} from "../../prototypes/_shared/data";
import {
  binderCount as p2BinderCount,
  buildPages as p2BuildPages,
  type BinderCount,
  type BuildInput,
  type Livery,
  type PageModel,
  type PocketModel,
  type SlotRef,
} from "../../prototypes/p2/model";
import type { BrowseFilter, CollectionBinder } from "../store";
import { labelOf, ruleTeamId } from "./label";

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const EMPTY: PocketModel = { content: { kind: "empty" } };

/** A pocket on the Want List knows which binder its want is for (null: none). */
export interface BinderPocket extends PocketModel {
  wantFor?: BinderId | null;
}

/** Chop pockets into pages of nine, padding the last with empty sleeves. */
export function paginate(pockets: PocketModel[], section: string | null): PageModel[] {
  const pages: PageModel[] = [];
  for (let i = 0; i < pockets.length; i += 9) {
    const chunk = pockets.slice(i, i + 9);
    while (chunk.length < 9) chunk.push(EMPTY);
    pages.push({ pockets: chunk, section });
  }
  return pages;
}

export interface WantGroup {
  binderId: BinderId | null;
  cards: Card[];
}

/** The section heading over a group of wants. */
export function wantSection(binderId: BinderId | null, nameOf: (id: BinderId) => string | undefined) {
  if (binderId === null) return "Just want it";
  return `For ${nameOf(binderId) ?? "a binder"}`;
}

/**
 * The Want List, opened: one run of pages per group (unscoped wants first,
 * as `wantsByBinder()` orders them), each group starting a fresh page like a
 * new section of a real binder. A want you have since landed shows the card
 * in its sleeve; the rest are "Need" sleeves.
 */
export function wantPages(
  groups: WantGroup[],
  copies: Copy[],
  nameOf: (id: BinderId) => string | undefined,
): PageModel[] {
  const pages: PageModel[] = [];
  for (const group of groups) {
    const pockets = group.cards.map((card): BinderPocket => {
      const mine = copiesOf(card.id, copies);
      return {
        content: mine.length ? { kind: "have", card, copies: mine } : { kind: "need", card },
        wantFor: group.binderId,
      };
    });
    pages.push(...paginate(pockets, wantSection(group.binderId, nameOf)));
  }
  return pages;
}

/** Every card on the pages, in order, once: what the drawer's ↑ ↓ step through. */
export function cardsOnPages(pages: PageModel[]): string[] {
  const seen = new Set<string>();
  for (const page of pages) {
    for (const { content } of page.pockets) {
      if (content.kind !== "empty") seen.add(content.card.id);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// A binder laid out in checklist order ('96 Contenders)
// ---------------------------------------------------------------------------
//
// p2 calls a binder a set binder only when EVERY filled pocket sits where the
// checklist puts it, so one extra copy anywhere switched its Need sleeves
// off. Here the numbered pages are the checklist (pocket N holds card N) and
// everything after them is "Extras": a second copy, a stray card. Extras
// never count against the checklist, and nothing is ever slotted into
// another card's numbered pocket.

/** The checklist section a card files under: each insert alone, parallels together. */
function sectionOf(card: Card): string {
  if (card.variantPath.type === "Base") return "Base";
  if (card.variantPath.type === "Inserts") return card.variantPath.name ?? "Inserts";
  return "Parallels";
}

export const EXTRAS = "Extras";

/** Where the Extras pages start: the first pocket after the checklist's last page. */
export function extrasStart(checklist: Card[]): number {
  return Math.ceil(checklist.length / 9) * 9;
}

/**
 * The checklist a binder's numbered pockets follow, or null. Decided from
 * ids every time, never stored: the first filled pocket names the set and
 * section, and every filled pocket inside the checklist must hold card N in
 * pocket N. Pockets past the checklist are Extras and do not count.
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
  if (filled.length === 0) return null;
  const first = filled[0][1];
  const list = cardsInSet(first.setId, {
    type: first.variantPath.type,
    name: first.variantPath.name,
  }).filter((c) => c.variation === null);
  const numbered = filled.filter(([i]) => i < list.length);
  if (numbered.length < 3) return null;
  return numbered.every(([i, card]) => list[i]?.id === card.id) ? list : null;
}

/** p2's spine count, reading the checklist the Extras-aware way. */
export function binderTally(binder: Binder, copies: Copy[]): BinderCount {
  if (binder.kind !== "manual") return p2BinderCount(binder, copies);
  const cards = binderCopies(binder, copies).reduce((n, c) => n + c.quantity, 0);
  const followed = followedChecklist(binder, copies);
  if (!followed) return { cards };
  const owned = new Set(copies.filter((c) => c.quantity > 0).map((c) => c.cardId));
  const have = followed.filter((c) => owned.has(c.id)).length;
  return { cards, have, need: followed.length - have };
}

function slotAt(layout: ManualBinder["layout"], i: number): string | null {
  return layout?.[Math.floor(i / 9)]?.slots[i % 9] ?? null;
}

function refOf(binder: ManualBinder, i: number): SlotRef {
  return { binderId: binder.id, page: Math.floor(i / 9), slot: i % 9 };
}

/**
 * Where a card goes when the collector says "put it in this binder": its
 * own numbered pocket when the binder follows a checklist and that pocket is
 * free; otherwise (a second copy, or a card from another set) the first
 * free pocket on the Extras pages. A binder with no checklist takes the
 * first free pocket anywhere. A full binder grows a page.
 */
export function pocketFor(binder: ManualBinder, card: Card, copies: Copy[]): SlotRef {
  const layout = binder.layout ?? [];
  const total = layout.length * 9;
  const followed = followedChecklist(binder, copies);
  if (followed) {
    const own = followed.findIndex((c) => c.id === card.id);
    if (own !== -1 && slotAt(layout, own) === null) return refOf(binder, own);
    const from = extrasStart(followed);
    for (let i = from; i < total; i++) if (slotAt(layout, i) === null) return refOf(binder, i);
    return refOf(binder, Math.max(total, from));
  }
  for (let i = 0; i < total; i++) if (slotAt(layout, i) === null) return refOf(binder, i);
  return refOf(binder, total);
}

/**
 * A pocket the collector aimed at or dropped on. Inside a checklist's
 * numbered pages, pocket N is saved for card N: any other card is sent to
 * its own pocket or the Extras pages instead, and `savedFor` says why.
 */
export function guardPocket(
  binder: ManualBinder,
  slot: SlotRef,
  card: Card,
  copies: Copy[],
): { slot: SlotRef; savedFor: Card | null } {
  const followed = followedChecklist(binder, copies);
  const i = slot.page * 9 + slot.slot;
  if (!followed || i >= followed.length || followed[i].id === card.id) {
    return { slot, savedFor: null };
  }
  return { slot: pocketFor(binder, card, copies), savedFor: followed[i] };
}

/**
 * p2's pages, except:
 * - a manual binder laid out like the real one: its numbered pages keep
 *   their Need sleeves whatever sits on the Extras pages, and those pages
 *   say "Extras";
 * - a browsed set as "Just a stack": every card in checklist order, packed
 *   tight (laid out like a binder, each insert starts a fresh page).
 */
export function buildBinderPages(input: BuildInput): PageModel[] {
  const { view, mode, copies, binders } = input;
  if (view.kind === "set" && mode === "stack") {
    return paginate(
      cardsInSet(view.setId).map((card): PocketModel => {
        const mine = copiesOf(card.id, copies);
        return { content: mine.length ? { kind: "have", card, copies: mine } : { kind: "need", card } };
      }),
      null,
    );
  }
  const binder = view.kind === "binder" ? binders.find((b) => b.id === view.binderId) : undefined;
  if (!binder || binder.kind !== "manual" || !binder.layout || mode !== "pockets") {
    return p2BuildPages(input);
  }

  const byId = new Map(copies.map((c) => [c.id, c]));
  const followed = followedChecklist(binder, copies);
  const checklistPages = followed ? extrasStart(followed) / 9 : 0;
  const section = (p: number) =>
    followed ? (p < checklistPages ? sectionOf(followed[0]) : EXTRAS) : null;
  const slotted = new Set<string>();
  const pages: PageModel[] = binder.layout.map((page, p) => ({
    section: section(p),
    pockets: page.slots.map((id, s): PocketModel => {
      const slot = refOf(binder, p * 9 + s);
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
      section: followed && p >= checklistPages ? EXTRAS : null,
      note: followed ? undefined : "A fresh page",
      pockets: Array.from({ length: 9 }, (_, s) => ({
        slot: refOf(binder, p * 9 + s),
        content: { kind: "empty" as const },
      })),
    });
  }

  // Filed in the binder (from a copy's details) but in no pocket yet.
  const loose = binderCopies(binder, copies)
    .filter((c) => !slotted.has(c.id))
    .sort((a, b) => compareCards(getCard(a.cardId), getCard(b.cardId)));
  if (loose.length) {
    const pockets = loose.map(
      (copy): PocketModel => ({ content: { kind: "have", card: getCard(copy.cardId), copies: [copy] } }),
    );
    for (const page of paginate(pockets, null)) pages.push({ ...page, note: "Not in a pocket yet" });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/**
 * A binder's colours: its spine label's (see `label.ts`), so the open
 * binder's vinyl matches the spine it was pulled by. By role or by rule,
 * never by name.
 */
export function liveryOf(binder: CollectionBinder | "all"): Livery {
  const label = labelOf(binder);
  return { primary: label.background, secondary: label.text };
}

export { ruleTeamId };

// ---------------------------------------------------------------------------
// The smart binder's team rule
// ---------------------------------------------------------------------------

/**
 * "A team" means cards showing the team, in that jersey. Ticking "Also count
 * anyone who played for them" widens it to the team's alumni as well.
 */
export function teamRule(teamId: TeamId, alsoPlayedFor: boolean): BinderRule {
  const onCard: BinderRule = { kind: "teamOnCard", teamId };
  return alsoPlayedFor ? { kind: "or", rules: [onCard, { kind: "playedFor", teamId }] } : onCard;
}

// ---------------------------------------------------------------------------
// Share links (mock: no such route yet)
// ---------------------------------------------------------------------------

/** The collector's public handle. Mock: the real one comes from their profile. */
export const MOCK_HANDLE = "jason";

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

export function binderShareTarget(binder: CollectionBinder): ShareTarget {
  if (binder.system === "want") return { what: "your Want List", path: "want-list" };
  return { what: binder.name, path: `binders/${slugify(binder.name)}` };
}

/** A set you are flipping through: your copy of its checklist. */
export function setShareTarget(set: CardSet): ShareTarget {
  return { what: setLabel(set), path: `sets/${slugify(setLabel(set))}` };
}

/** The human-readable public link for a share target. */
export function shareUrl(target: ShareTarget, handle = MOCK_HANDLE): string {
  return `neonbinder.io/@${handle}/${target.path}`;
}

/** A human-readable public link to a binder, or to the Want List. */
export function shareLink(binder: CollectionBinder, handle = MOCK_HANDLE): string {
  return shareUrl(binderShareTarget(binder), handle);
}

// ---------------------------------------------------------------------------
// Browse a set: the shelf's filters
// ---------------------------------------------------------------------------

function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The sets the Browse shelf shows: one sport (or all), a year range (either
 * end open, ends inclusive and swapped if typed backwards) and every word of
 * the name typed ("96 contenders", "chrome").
 */
export function filterSets(sets: CardSet[], filter: BrowseFilter): CardSet[] {
  let { from, to } = filter;
  if (from !== null && to !== null && from > to) [from, to] = [to, from];
  const words = foldText(filter.q).split(" ").filter(Boolean);
  return sets.filter((set) => {
    if (filter.sport !== "all" && set.sportId !== filter.sport) return false;
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

// ---------------------------------------------------------------------------
// Where a card lives (the hunt tray)
// ---------------------------------------------------------------------------

/** One place a card lives: a binder, and a pocket when it sits in one. */
export interface Place {
  binderId: BinderId;
  binderName: string;
  /** The pocket on the binder's pages, or null when it is just filed there. */
  pocket: { page: number; slot: number } | null;
  /** The line items in this place (one, for a pocket). */
  copyIds: string[];
  /** Cards in this place, counting a line item's quantity. */
  quantity: number;
}

/**
 * Every place the collector's copies of a card live, binder by binder in
 * shelf order. A copy in a pocket is its own place ("'96 Contenders, page 2,
 * pocket 4"); copies just filed in a binder share one ("Main", ×2). A copy
 * filed in two binders (Main and Up for Trade) is in both.
 */
export function placesOf(cardId: string, copies: Copy[], binders: CollectionBinder[]): Place[] {
  const mine = copies.filter((c) => c.cardId === cardId);
  const places: Place[] = [];
  for (const binder of binders) {
    const here = mine.filter((c) => c.binderIds.includes(binder.id));
    if (here.length === 0) continue;
    const loose: Copy[] = [];
    const pocketed: Place[] = [];
    for (const copy of here) {
      let pocket: Place["pocket"] = null;
      if (binder.kind === "manual") {
        binder.layout?.forEach((page, p) =>
          page.slots.forEach((id, slot) => {
            if (id === copy.id && !pocket) pocket = { page: p, slot };
          }),
        );
      }
      if (pocket) {
        pocketed.push({ binderId: binder.id, binderName: binder.name, pocket, copyIds: [copy.id], quantity: copy.quantity });
      } else {
        loose.push(copy);
      }
    }
    pocketed.sort((a, b) => a.pocket!.page - b.pocket!.page || a.pocket!.slot - b.pocket!.slot);
    places.push(...pocketed);
    if (loose.length) {
      places.push({
        binderId: binder.id,
        binderName: binder.name,
        pocket: null,
        copyIds: loose.map((c) => c.id),
        quantity: loose.reduce((n, c) => n + c.quantity, 0),
      });
    }
  }
  return places;
}

/** "'96 Contenders, page 2, pocket 4", "Main", "Main ×2". */
export function placeWords(place: Place): string {
  if (place.pocket) return `${place.binderName}, page ${place.pocket.page + 1}, pocket ${place.pocket.slot + 1}`;
  return place.quantity > 1 ? `${place.binderName} ×${place.quantity}` : place.binderName;
}

/** The copies of a card that "Move here" may move into `to`: any not already there. */
export function movableCopies(cardId: string, copies: Copy[], to: BinderId): Copy[] {
  return copies.filter((c) => c.cardId === cardId && !c.binderIds.includes(to));
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
 * What Enter in the pack may act on. A card number is not unique (a set has
 * #1 in Base and #1 in every parallel), so a search only resolves to a card
 * when it fits every word AND exactly one card fits.
 */
export function resolveTyped(hits: SearchHit[]): TypedCard {
  const full = hits.filter((h) => h.matchedAll);
  if (full.length === 0) return { kind: "none" };
  if (full.length === 1) return { kind: "one", card: full[0].card };
  return { kind: "many", count: full.length };
}

/** The copy a per-copy pocket holds, so the drawer can ring its line item. */
export function soleCopyId(copies: Copy[]): string | undefined {
  return copies.length === 1 ? copies[0].id : undefined;
}

export { getCard };
