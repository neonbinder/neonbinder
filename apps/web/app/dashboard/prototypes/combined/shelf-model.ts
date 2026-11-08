/**
 * NEO-464 combined dashboard — the binders on the one shelf, what each holds,
 * what came in since the last visit, what a pocket page shows, and which of
 * your cards COULD FIT a smart binder (block 5). Adapted from prototype 4's
 * model; derived from the shared fixture and the collection demo's seed, so
 * counts match what the demo binder shows.
 *
 * One shelf, no split: Main, the seed's manual binders (minus Trade bait,
 * whose single copies are the trade pile) and the smart binders stand
 * together, ordered by the shelf (see `shelfOrder`).
 *
 * Smart binders here do NOT fill themselves. A smart binder holds the cards
 * you filed in it; its rule only says which of your cards could fit. The
 * fixture has no "filed" flag, so the demo draws the line at the last visit:
 * matching cards you owned before it are filed; matching cards that came in
 * since (`SmartBinderSummary.newCards` in the fixture) are not filed yet, so
 * they are the "could fit" candidates, and a smart spine wears no "new"
 * sticker this visit. A percent shows only where the rule names a checklist.
 *
 * Spine colours are the vinyl of a physical binder: the livery of the team
 * most of its cards wear, never a theme colour.
 */

import { dashCard, type DashCard, type DashboardData, type SmartBinderSummary } from "../_shared/data";
import {
  binderCards,
  binderCopies,
  binders as seedBinders,
  myCopies,
  type Binder,
  type BinderRule,
} from "@/app/collection/prototypes/_shared/data";

/** One spine on the shelf. */
export interface ShelfBinder {
  /** Stable id; also the `?binder=` value that opens it. */
  id: string;
  name: string;
  kind: "manual" | "smart";
  /** A smart binder's rule in words ("Red Wings on the card"); null for a manual one. */
  ruleText: string | null;
  /** Physical cards filed in it (copies, stacks counted). */
  cardCount: number;
  /** Cards filed in it since the last visit, newest first. */
  newCards: DashCard[];
  /** Smart only: cards of yours its rule matches that are not filed in it yet. */
  couldFit: DashCard[];
  /** Only when a smart binder's rule names a checklist. */
  checklist: { have: number; total: number; percent: number } | null;
  /** The spine's vinyl and the stripe above its label. */
  vinyl: string;
  stripe: string;
}

/** One pocket on a page: a card you have, or an empty pocket. */
export type Pocket =
  | { kind: "card"; card: DashCard; isNew: boolean; key: string }
  | { kind: "empty"; key: string; card: DashCard | null };

export const POCKETS_PER_PAGE = 9;

const MAIN_ID = "main";
const TRADE_BAIT_ID = "binder-trade-bait";

/**
 * The fixture's one smart binder that is not in the demo seed ('93 Finest,
 * every card) does not export its rule; it is restated here so its pocket
 * page can draw the checklist. Keep in step with `_shared/data.ts`.
 */
const EXTRA_RULES: Record<string, BinderRule> = {
  "smart-93-finest": { kind: "set", setId: "1993-finest-baseball" },
};

/** House vinyl for a binder with no team of its own (Main). */
const HOUSE_VINYL = { vinyl: "#1f2a44", stripe: "#00c2ff" };

function liveryOf(cards: DashCard[]): { vinyl: string; stripe: string } {
  const tally = new Map<string, { n: number; primary: string; secondary: string }>();
  for (const c of cards) {
    const team = c.card.teams[0];
    if (!team?.primary) continue;
    const prev = tally.get(team.name);
    if (prev) prev.n += 1;
    else tally.set(team.name, { n: 1, primary: team.primary, secondary: team.secondary ?? team.primary });
  }
  let best: { n: number; primary: string; secondary: string } | null = null;
  for (const t of tally.values()) if (!best || t.n > best.n) best = t;
  return best ? { vinyl: best.primary, stripe: best.secondary } : HOUSE_VINYL;
}

/** Distinct cards of a list of copies, in the order given. */
function distinctCards(copies: { cardId: string }[]): DashCard[] {
  const seen = new Set<string>();
  const out: DashCard[] = [];
  for (const c of copies) {
    if (seen.has(c.cardId)) continue;
    seen.add(c.cardId);
    out.push(dashCard(c.cardId));
  }
  return out;
}

function mainCopies() {
  return myCopies.filter((c) => c.binderIds.length === 0);
}

function quantityOf(copies: { quantity: number }[]): number {
  return copies.reduce((n, c) => n + c.quantity, 0);
}

/** New cards since the last visit, by the binder they were filed in. */
function newByBinderName(data: DashboardData): Map<string, DashCard[]> {
  const out = new Map<string, DashCard[]>();
  for (const batch of data.additions) {
    if (!batch.sinceLastVisit) continue;
    for (const c of batch.cards) {
      const list = out.get(c.binderName) ?? [];
      if (!list.some((x) => x.id === c.id)) list.push(c);
      out.set(c.binderName, list);
    }
  }
  return out;
}

/** Cards that came in since the last visit match a smart rule but are not filed in it (see the file comment). */
function couldFitOf(s: SmartBinderSummary): DashCard[] {
  return s.newCards;
}

/** Every binder on the shelf, in the fixture's order (Main first). `shelfOrder` sorts them. */
export function bindersOf(data: DashboardData): ShelfBinder[] {
  const fresh = newByBinderName(data);

  const main: ShelfBinder = {
    id: MAIN_ID,
    name: "Main",
    kind: "manual",
    ruleText: null,
    cardCount: quantityOf(mainCopies()),
    newCards: fresh.get("Main") ?? [],
    couldFit: [],
    checklist: null,
    ...HOUSE_VINYL,
  };

  const manual: ShelfBinder[] = seedBinders
    .filter((b) => b.kind === "manual" && b.id !== TRADE_BAIT_ID)
    .map((b) => {
      const copies = binderCopies(b);
      return {
        id: b.id,
        name: b.name,
        kind: "manual",
        ruleText: null,
        cardCount: quantityOf(copies),
        newCards: fresh.get(b.name) ?? [],
        couldFit: [],
        checklist: null,
        ...liveryOf(distinctCards(copies)),
      };
    });

  const smart: ShelfBinder[] = data.smartBinders.map((s) => {
    const couldFit = couldFitOf(s);
    const unfiled = new Set(couldFit.map((c) => c.id));
    const unfiledCopies = myCopies.filter((c) => unfiled.has(c.cardId));
    return {
      id: s.id,
      name: s.name,
      kind: "smart",
      ruleText: s.ruleText,
      cardCount: s.cardCount - quantityOf(unfiledCopies),
      newCards: [],
      couldFit,
      checklist: s.checklist ?? null,
      ...liveryOf(contentsOf(s.id, unfiled).cards),
    };
  });

  return [main, ...manual, ...smart];
}

/**
 * The shelf's order, which is also how the capped shelf picks its binders:
 * binders with new cards first, most new first; then the fullest binders
 * (most cards). Ties keep the fixture's order. Take the first 24 for the
 * shelf; fewer than that and they all stand.
 */
export function shelfOrder(binders: ShelfBinder[]): ShelfBinder[] {
  return [...binders].sort((a, b) => b.newCards.length - a.newCards.length || b.cardCount - a.cardCount);
}

function binderById(id: string): Binder | null {
  const seed = seedBinders.find((b) => b.id === id);
  if (seed) return seed;
  const rule = EXTRA_RULES[id];
  return rule ? { id, kind: "smart", name: id, description: "", rule } : null;
}

/**
 * What a binder holds, in its own order: a binder with pages keeps them
 * (empty pockets included); a checklist binder shows every card of the
 * checklist, with an empty pocket where one is not filed; anything else is
 * the cards filed in it. `unfiled` leaves a smart binder's could-fit cards out.
 */
function contentsOf(
  id: string,
  unfiled: Set<string> = new Set(),
): { cards: DashCard[]; pages: (string | null)[][] | null; checklist: boolean } {
  if (id === MAIN_ID) return { cards: distinctCards(mainCopies()), pages: null, checklist: false };
  const binder = binderById(id);
  if (!binder) return { cards: [], pages: null, checklist: false };
  if (binder.kind === "manual" && binder.layout) {
    const cardOfCopy = new Map(myCopies.map((c) => [c.id, c.cardId]));
    const pages = binder.layout.map((p) => p.slots.map((slot) => (slot ? (cardOfCopy.get(slot) ?? null) : null)));
    return { cards: distinctCards(binderCopies(binder)), pages, checklist: false };
  }
  if (binder.kind === "smart" && binder.rule.kind === "set") {
    return { cards: binderCards(binder).map((c) => dashCard(c.id)), pages: null, checklist: true };
  }
  return {
    cards: distinctCards(binderCopies(binder).filter((c) => !unfiled.has(c.cardId))),
    pages: null,
    checklist: false,
  };
}

const ownedIds = new Set(myCopies.map((c) => c.cardId));

/**
 * The binder's pockets, nine to a page. A plain binder leads with what came
 * in since the last visit (so the first page is the news), then the rest in
 * checklist order. A binder with pages, or a checklist, keeps its own order
 * and marks the new ones where they sit.
 */
export function pocketsOf(binder: ShelfBinder): Pocket[] {
  const unfiled = new Set(binder.couldFit.map((c) => c.id));
  const { cards, pages, checklist } = contentsOf(binder.id, unfiled);
  const fresh = new Set(binder.newCards.map((c) => c.id));

  if (pages) {
    return pages.flatMap((slots, p) =>
      slots.map((cardId, s): Pocket => {
        const key = `p${p}-s${s}`;
        if (!cardId) return { kind: "empty", key, card: null };
        return { kind: "card", card: dashCard(cardId), isNew: fresh.has(cardId), key };
      }),
    );
  }

  if (checklist) {
    return cards.map(
      (c): Pocket =>
        ownedIds.has(c.id) && !unfiled.has(c.id)
          ? { kind: "card", card: c, isNew: fresh.has(c.id), key: c.id }
          : { kind: "empty", key: c.id, card: c },
    );
  }

  const rest = cards.filter((c) => !fresh.has(c.id));
  return [
    ...binder.newCards.map((c): Pocket => ({ kind: "card", card: c, isNew: true, key: c.id })),
    ...rest.map((c): Pocket => ({ kind: "card", card: c, isNew: false, key: c.id })),
  ];
}

/**
 * A smart binder's checklist, card by card, when its rule names one (else
 * null): every card the rule names, in checklist order, and whether it is
 * filed in the binder. Reads only that one binder's cards, never every set.
 */
export function checklistOf(binder: ShelfBinder): { card: DashCard; filed: boolean }[] | null {
  if (binder.kind !== "smart" || !binder.checklist) return null;
  const unfiled = new Set(binder.couldFit.map((c) => c.id));
  const { cards, checklist } = contentsOf(binder.id, unfiled);
  if (!checklist) return null;
  return cards.map((card) => ({ card, filed: ownedIds.has(card.id) && !unfiled.has(card.id) }));
}

export function pageCount(binder: ShelfBinder): number {
  return Math.max(1, Math.ceil(pocketsOf(binder).length / POCKETS_PER_PAGE));
}
