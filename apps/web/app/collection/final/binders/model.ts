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
  type Binder,
  type BinderId,
  type BinderRule,
  type Card,
  type Copy,
  type ManualBinder,
  type SearchHit,
  type TeamId,
} from "../../prototypes/_shared/data";
import {
  binderCount as p2BinderCount,
  binderLivery as p2Livery,
  buildPages as p2BuildPages,
  type BinderCount,
  type BuildInput,
  type Livery,
  type PageModel,
  type PocketModel,
  type SlotRef,
} from "../../prototypes/p2/model";
import type { CollectionBinder } from "../store";

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
 * p2's pages, except a manual binder laid out like the real one: its
 * numbered pages keep their Need sleeves whatever sits on the Extras pages,
 * and those pages say "Extras".
 */
export function buildBinderPages(input: BuildInput): PageModel[] {
  const { view, mode, copies, binders } = input;
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

/** The special shelf's vinyl: picked by role, never by name. */
const SYSTEM_LIVERY: Record<NonNullable<CollectionBinder["system"]>, Livery> = {
  main: { primary: "#14532d", secondary: "#00D558" },
  want: { primary: "#4a0b33", secondary: "#FF2E9A" },
  trade: { primary: "#5c4a00", secondary: "#FFE600" },
};

/** The rule's team, when a smart binder is "a team" (with or without alumni). */
export function ruleTeamId(rule: BinderRule): TeamId | null {
  if (rule.kind === "teamOnCard" || rule.kind === "playedFor") return rule.teamId;
  if (rule.kind === "or") {
    for (const r of rule.rules) {
      const id = ruleTeamId(r);
      if (id) return id;
    }
  }
  return null;
}

export function liveryOf(binder: CollectionBinder | "all"): Livery {
  if (binder === "all") return p2Livery("all");
  if (binder.system) return SYSTEM_LIVERY[binder.system];
  if (binder.kind === "smart") {
    const teamId = ruleTeamId(binder.rule);
    if (teamId && binder.rule.kind === "or") {
      // p2 only knows a bare team rule; hand it the same team.
      return p2Livery({ ...binder, rule: { kind: "teamOnCard", teamId } });
    }
  }
  return p2Livery(binder);
}

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

/** A human-readable public link to a binder, or to the Want List. */
export function shareLink(binder: CollectionBinder, handle = MOCK_HANDLE): string {
  if (binder.system === "want") return `neonbinder.io/@${handle}/want-list`;
  return `neonbinder.io/@${handle}/binders/${slugify(binder.name)}`;
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
