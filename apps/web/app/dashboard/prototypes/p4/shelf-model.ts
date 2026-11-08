/**
 * NEO-464 — prototype 4 ("Binder shelf"): which binders stand on the shelf,
 * how many cards each holds, what came in since the last visit, and what a
 * pocket page shows when one is pulled.
 *
 * Everything is derived from the shared fixture (`../_shared/data`) and the
 * collection demo's seed it was built from, so the counts here are the
 * counts the demo binder shows. Nothing is invented:
 *
 * - Your binders: Main (copies filed nowhere else) and the seed's manual
 *   binders, minus Trade bait (its single copies are the Up for Trade pile,
 *   shown on its own). Their "new" counts come from the addition batches
 *   since the last visit, by the binder each card was filed in.
 * - Smart binders: the fixture's `smartBinders`, as they are. A percent only
 *   where the summary carries a `checklist`.
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
  /** Physical cards in it (copies, stacks counted). */
  cardCount: number;
  /** Cards that came in since the last visit, newest first. */
  newCards: DashCard[];
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

/** Your binders first (Main leading), then the smart ones. */
export function shelfOf(data: DashboardData): { mine: ShelfBinder[]; smart: ShelfBinder[] } {
  const fresh = newByBinderName(data);

  const main: ShelfBinder = {
    id: MAIN_ID,
    name: "Main",
    kind: "manual",
    ruleText: null,
    cardCount: quantityOf(mainCopies()),
    newCards: fresh.get("Main") ?? [],
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
        checklist: null,
        ...liveryOf(distinctCards(copies)),
      };
    });

  const smart: ShelfBinder[] = data.smartBinders.map((s: SmartBinderSummary) => ({
    id: s.id,
    name: s.name,
    kind: "smart",
    ruleText: s.ruleText,
    cardCount: s.cardCount,
    newCards: s.newCards,
    checklist: s.checklist ?? null,
    ...liveryOf(contentsOf(s.id).cards),
  }));

  return { mine: [main, ...manual], smart };
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
 * checklist, with an empty pocket where one is still needed; anything else
 * is the cards you have.
 */
function contentsOf(id: string): { cards: DashCard[]; pages: (string | null)[][] | null; checklist: boolean } {
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
  return { cards: distinctCards(binderCopies(binder)), pages: null, checklist: false };
}

const ownedIds = new Set(myCopies.map((c) => c.cardId));

/**
 * The binder's pockets, nine to a page. A plain binder leads with what came
 * in since the last visit (so the first page is the news), then the rest in
 * checklist order. A binder with pages, or a checklist, keeps its own order
 * and marks the new ones where they sit.
 */
export function pocketsOf(binder: ShelfBinder): Pocket[] {
  const { cards, pages, checklist } = contentsOf(binder.id);
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
        ownedIds.has(c.id) ? { kind: "card", card: c, isNew: fresh.has(c.id), key: c.id } : { kind: "empty", key: c.id, card: c },
    );
  }

  const rest = cards.filter((c) => !fresh.has(c.id));
  return [
    ...binder.newCards.map((c): Pocket => ({ kind: "card", card: c, isNew: true, key: c.id })),
    ...rest.map((c): Pocket => ({ kind: "card", card: c, isNew: false, key: c.id })),
  ];
}
