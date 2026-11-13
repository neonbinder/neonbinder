/**
 * NEO-464 — the signed-in dashboard's data, from the collector's real
 * collection through the collection store's hooks (mounted by
 * `ConvexCollectionProvider` in `../page.tsx`).
 *
 * Filled from the store: the shelf and the open binder's pocket pages
 * (slice 1); the chase off the Want List, the trade pile, and the boxes held
 * off the marketplaces (slice 2). Slice 3, from `convex/dashboard.ts`
 * (`./useDashboardServer`):
 * - the set boards: the sets the collector is building (`useBuildingSets`,
 *   most recently picked first, at most `BOARD_SETS`), each one's base
 *   checklist read ONCE (never subscribed), only the few needs the board
 *   names hydrated;
 * - "just completed": a set's base checklist held whole, finished in the
 *   last `JUST_COMPLETED_DAYS` days (read once; see `dashboard.justCompleted`);
 * - smart binders: the rule in words, and a checklist percent read once from
 *   the binder's stored fits when the rule names a checklist;
 * - "new since your last visit": the visit is stamped on mount
 *   (`dashboard.markVisit`), and the collection lines filed (added or moved
 *   in) since the last one fill each binder's `newCards` (subscribed, at most
 *   100 lines).
 * Slice 4, also from `convex/dashboard.ts`, each read once on mount:
 * - could fit: each smart binder's cards held in another binder that its
 *   rule takes in, from its stored fits (at most 20 a binder, for the first
 *   `SMART_CHECKLISTS` smart binders; only the strip's preview is hydrated);
 * - the hopper: what is still in intake across the recent runs
 *   (`dashboard.intake`; photos still being processed are not counted),
 *   each run linking to the Add cards tab that finishes it;
 * - the sales section: the account sells (at least one order stored; a
 *   connected login alone never shows it), and its newest orders still to ship (`dashboard.sales`, at
 *   most 10), shown oldest first. "Shipped" is the platform's own status:
 *   NB keeps no shipped state; an unpaid order, or one in a status NB does
 *   not know, is never one to ship.
 * - Fresh Pulls: the cards added new to the collection in the last two
 *   weeks (`dashboard.freshPulls`; never a move; subscribed);
 * - New on NeonBinder: the latest checklist uploads, grouped by set, each
 *   opening its checklist (read once).
 * Review round 4:
 * - New Listings: the cards that landed in a box in the last two weeks, with
 *   quantity and NB's price (`dashboard.newListings`; subscribed);
 * - the sync status at the top: cards waiting to sync, and the sets whose
 *   latest sync failed or held cards back (`dashboard.syncAlerts`; read once);
 * - the third shelf: the boxes in use, when there are any (`shelfBoxesOf`).
 *
 * Shelf rows are the collector's binders: Main and their own, never a box,
 * the Want List or the trade pile (`bindersOf` in the store). Spines wear
 * the label the binder wears on My Binders (`labelOf`). Only the open
 * binder (`?binder=<id>`, pushed by the screen) reads its copies.
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useCardMap } from "@/app/collection/final/binders/hooks";
import { binderPages, type CardsById, type PageModel } from "@/app/collection/final/binders/model";
import { labelOf } from "@/app/collection/final/binders/label";
import { describeSmartRule } from "@/app/collection/final/binders/RuleBuilder";
import {
  bindersOf,
  boxesOf,
  systemContainer,
  useBuildingSets,
  useContainerCopies,
  useContainers,
  useSummary,
  useTradeCopies,
  useWants,
} from "@/app/collection/final/data/store";
import type {
  Card,
  CardId,
  CollectionSummary,
  Container,
  ContainerCopies,
  ContainerLabel,
  SetRef,
  Want,
} from "@/app/collection/final/data/types";
import { problemSentence } from "@/app/collection/final/inventory/listing/copy";
import { dashSetLabel, setRefLabel, toDash, type DashCard } from "../dash-card";
import type {
  AddedCard,
  AdditionBatch,
  BuildingSet,
  CompletedSet,
  DashboardData,
  IntakeInProgress,
  IntakeUpload,
  NewListing,
  NewSet,
  SaleLine,
  SalesData,
  ShelfBox,
  SmartBinderSummary,
  SyncStatusData,
  TradePile,
  UnlistedBox,
  UnshippedSale,
  WantCard,
} from "../fake-data";
import { daysAgoLabel, type Marketplace } from "../dash-labels";
import { NEED_NAMED } from "../screen/Boards";
import { COULD_FIT_PREVIEW } from "../screen/CouldFit";
import type { Pocket, ShelfBinder } from "../screen/shelf-model";
import {
  useCouldFit,
  useFreshPullLines,
  useIntakeRaw,
  useJustCompletedRaw,
  useNewListingLines,
  useNewSets,
  useNewSince,
  useSalesRaw,
  useSyncAlertsRaw,
  useSetBoards,
  useSmartChecklists,
  useVisitSince,
  type CompletionRaw,
  type CouldFitRaw,
  type IntakeRaw,
  type NewSetRaw,
  type NewListingsRaw,
  type NewSinceRaw,
  type FreshPullsRaw,
  type SyncAlertsRaw,
  type SalesRaw,
  type SetBoardRaw,
} from "./useDashboardServer";

/** The screen's URL parameter for the open binder (`DashboardScreen`). */
export const BINDER_PARAM = "binder";

const NO_INTAKE: IntakeInProgress = {
  total: 0,
  needsYou: 0,
  unidentified: 0,
  uploads: [],
  sortedThisWeek: 0,
  sortedAllTime: 0,
  sortedAllTimeMore: false,
};

/** The chase: the Want List's newest wants, at most this many (and only their cards are read). */
export const CHASE_CAP = 12;
/** Trade pile copies read for its thumbnails; the count is the pile's own. */
export const TRADE_PREVIEW = 6;
/** A checklist finished within this many days reads as "just completed". */
export const JUST_COMPLETED_DAYS = 10;
/** The most recent completions kept. */
export const JUST_COMPLETED_CAP = 3;
/** Sets on the board: the most recently picked of the sets being built. */
export const BOARD_SETS = 6;
/** Smart binders whose checklist is counted (each is one read on mount). */
export const SMART_CHECKLISTS = 8;

const NO_TRADE: TradePile = { count: 0, cards: [] };

/** The rule in words, when the binder is smart and its rule can be said. */
function ruleTextOf(container: Container): string | null {
  if (!container.smartRule) return null;
  const text = describeSmartRule(container.smartRule, container.ruleNames ?? {});
  return text.length > 0 ? text : null;
}

/** Whole percent, floored, so 99.6% never reads as done. */
function percentOf(have: number, total: number): number {
  return total === 0 ? 0 : Math.floor((have / total) * 100);
}

/** What a spine carries beyond its container: the news since the last visit, a smart binder's checklist count and its could-fit cards. */
export interface SpineExtras {
  newCards?: DashCard[];
  checklist?: { have: number; total: number } | null;
  couldFit?: CouldFitCards;
}

/** A smart binder's could-fit cards: the strip's preview hydrated, and how many there are. */
export interface CouldFitCards {
  cards: DashCard[];
  count: number;
  more: boolean;
}

/**
 * One container as a spine. `pockets` are the open binder's pages (empty for
 * every other spine). A count of null means not counted yet: it stands at 0
 * until the store has counted it. A checklist count and could-fit cards
 * show only on a smart binder.
 */
/** A label, and its colours as the spine's vinyl and stripe. */
function labelled(label: ContainerLabel): Pick<ShelfBinder, "label" | "vinyl" | "stripe"> {
  return { label, vinyl: label.background, stripe: label.text };
}

export function shelfBinderOf(container: Container, pockets: Pocket[] = [], extras: SpineExtras = {}): ShelfBinder {
  const smart = !!container.smartRule;
  const list = smart && extras.checklist && extras.checklist.total > 0 ? extras.checklist : null;
  return {
    id: container.id,
    name: container.name,
    kind: smart ? "smart" : "manual",
    ruleText: ruleTextOf(container),
    cardCount: container.count?.copies ?? 0,
    newCards: extras.newCards ?? [],
    couldFit: smart ? (extras.couldFit?.cards ?? []) : [],
    ...(smart && extras.couldFit ? { couldFitTotal: { count: extras.couldFit.count, more: extras.couldFit.more } } : {}),
    checklist: list ? { have: list.have, total: list.total, percent: percentOf(list.have, list.total) } : null,
    ...labelled(labelOf(container)),
    pockets,
    checklistCards: null,
  };
}

/**
 * A binder's pages (`binderPages`), flattened to the screen's pockets: nine
 * a page, so its page count is `pages.length`. A card in `fresh` (new since
 * the last visit) is marked new.
 */
export function pocketsOfPages(pages: readonly PageModel[], fresh?: ReadonlySet<CardId>): Pocket[] {
  return pages.flatMap((page, p) =>
    page.pockets.map((pocket, s): Pocket => {
      const key = `p${p}-s${s}`;
      const { content } = pocket;
      if (content.kind === "have") {
        return { kind: "card", card: toDash(content.card), isNew: fresh?.has(content.card.id) ?? false, key };
      }
      if (content.kind === "need") return { kind: "empty", key, card: toDash(content.card) };
      return { kind: "empty", key, card: null };
    }),
  );
}

/** Each card once, in the order given, as DashCards; a card not in `cards` (gone from the catalog) is skipped. */
function dashCardsOf(cardIds: readonly CardId[], cards: CardsById): DashCard[] {
  const seen = new Set<CardId>();
  const out: DashCard[] = [];
  for (const id of cardIds) {
    const card = cards.get(id);
    if (!card || seen.has(id)) continue;
    seen.add(id);
    out.push(toDash(card));
  }
  return out;
}

/**
 * The trade pile: its count is the Up for Trade shelf's own (physical cards,
 * kept by every write, a box's copies too); its cards are the first copies
 * listed, each card once. Not counted yet: 0.
 */
export function tradePileOf(trade: Container | undefined, listed: ContainerCopies | undefined, cards: CardsById | undefined): TradePile {
  const count = trade?.count?.copies ?? 0;
  if (count === 0) return NO_TRADE;
  const ids = listed ? listed.copies.slice(0, TRADE_PREVIEW).map((c) => c.cardId) : [];
  return { count, cards: cards ? dashCardsOf(ids, cards) : [] };
}

/**
 * The boxes the collector is using: any box they made, and Unsorted once a
 * card is in it. Unsorted is made on first use by the store, so an empty
 * one is not a box they have; a count not yet known reads as in use.
 */
export function boxesInUseOf(containers: readonly Container[]): number {
  return shelfBoxesOf(containers).length;
}

/**
 * The boxes the collector marked in-person only (NEO-370 "Listed on
 * marketplaces" off), Unsorted first: every card in one is held off the
 * marketplaces. The count is the box's own, as My Boxes shows it. A box not
 * counted yet, or empty, is left out.
 */
export function unlistedBoxesOf(containers: readonly Container[]): UnlistedBox[] {
  return boxesOf(containers)
    .filter((box) => box.listedOnMarketplaces === false)
    .map((box) => ({ id: box.id, name: box.name, unlisted: box.count?.copies ?? 0 }))
    .filter((box) => box.unlisted > 0);
}

/** The boxes in use (see `boxesInUseOf`), Unsorted first, as the third shelf draws them. */
export function shelfBoxesOf(containers: readonly Container[]): ShelfBox[] {
  return boxesOf(containers)
    .filter((box) => box.system !== "unsorted" || box.count === null || box.count.copies > 0)
    .map((box) => ({
      id: box.id,
      name: box.name,
      cardCount: box.count?.copies ?? 0,
      unsorted: box.system === "unsorted",
      label: labelOf(box),
    }));
}

/** The newest wants, at most `cap`. A want with no stamp was just set: it is the newest. */
export function chaseOf(wants: readonly Want[], cap = CHASE_CAP): Want[] {
  const stamp = (w: Want) => w.lastUpdated ?? Number.POSITIVE_INFINITY;
  return [...wants].sort((a, b) => stamp(b) - stamp(a)).slice(0, cap);
}

/**
 * The chase as cards, in the order given. `forBinder` is the name of the
 * binder or box the want is for, or null (just wanted, or that home is gone).
 */
export function wantCardsOf(chase: readonly Want[], containers: readonly Container[], cards: CardsById): WantCard[] {
  const names = new Map(containers.map((c) => [c.id, c.name]));
  return chase.flatMap((want) => {
    const card = cards.get(want.cardId);
    if (!card) return [];
    return [{ ...toDash(card), forBinder: (want.binderId && names.get(want.binderId)) ?? null }];
  });
}

/**
 * A checklist whose every card the collector holds, with the day its last
 * card came in: the newest `acquiredAt` among the copies that complete it.
 */
export interface CompletedChecklist {
  id: string;
  /** "2024 Topps Chrome Refractor". */
  label: string;
  setLabel: string;
  /** null for the base checklist. */
  checklistName: string | null;
  /** Cards in the checklist; absent, `cards` is all of them. */
  total?: number;
  /** Cards of the checklist to draw: every one, or (a big checklist) the last few in. */
  cards: DashCard[];
  /** The card whose copy came in last. */
  lastCard: DashCard;
  /** `YYYY-MM-DD`: when that copy came in. */
  completedOn: string;
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD` (calendar days, no time of day). */
function daysBetween(from: string, to: string): number {
  const day = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  return Math.round(day(to) - day(from));
}

/**
 * The checklists completed in the last `JUST_COMPLETED_DAYS` days (today
 * counts as day 0, so day 10 is the last one in), newest first, at most
 * `JUST_COMPLETED_CAP`. A date after `today` (a clock or a typo) is left out.
 */
export function recentCompletions(done: readonly CompletedChecklist[], today: string): CompletedChecklist[] {
  return done
    .map((c) => ({ c, days: daysBetween(c.completedOn, today) }))
    .filter(({ days }) => days >= 0 && days <= JUST_COMPLETED_DAYS)
    .sort((a, b) => a.days - b.days)
    .slice(0, JUST_COMPLETED_CAP)
    .map(({ c }) => c);
}

/** The newest of `recentCompletions` as the screen's cheer, or null. */
export function justCompletedOf(done: readonly CompletedChecklist[], today: string): CompletedSet | null {
  const [newest] = recentCompletions(done, today);
  if (!newest) return null;
  return {
    id: newest.id,
    label: newest.label,
    setLabel: newest.setLabel,
    checklistName: newest.checklistName,
    total: newest.total ?? newest.cards.length,
    lastCard: newest.lastCard,
    cards: newest.cards,
    whenLabel: daysAgoLabel(daysBetween(newest.completedOn, today)),
  };
}

// ---------------------------------------------------------------------------
// Fresh Pulls: the cards added new to the collection lately
// ---------------------------------------------------------------------------

/** Fresh Pulls looks back this many calendar days, today included. */
export const FRESH_PULLS_DAYS = 14;
/** At most this many of the newest added lines are drawn (and hydrated). */
export const FRESH_PULLS_CARDS = 48;

/** The first instant Fresh Pulls covers: local midnight, `FRESH_PULLS_DAYS - 1` days before `now`'s day. */
export function freshPullsWindowStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (FRESH_PULLS_DAYS - 1)).getTime();
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A pull's day, relative, never a date: "Today", "Yesterday", "Tuesday", then "Last Tuesday". */
export function pullDayLabel(at: number, now: number): string {
  const days = daysBetween(localDay(at), localDay(now));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const weekday = WEEKDAYS[new Date(at).getDay()];
  return days < 7 ? weekday : `Last ${weekday}`;
}

/**
 * Fresh Pulls from the added lines (newest first): one batch a day, newest
 * day first, each card once per binder, in the binders the shelf names (a
 * line whose home is not on it is left out). Only cards new to the
 * collection count (Jason, 2026-11-10: "never moves"): a scan saved into a
 * binder, an add on Collection, a pasted range; a move, a split or an
 * emptied binder never does (`dashboard.freshPulls`). A card not hydrated
 * yet waits. `since`: the last visit (null on the first, so every batch is
 * new; undefined while it loads, so none is).
 */
export function freshPullsOf(
  lines: FreshPullsRaw["lines"],
  cards: CardsById | undefined,
  homeNames: ReadonlyMap<string, string>,
  since: number | null | undefined,
  now: number,
): AdditionBatch[] {
  if (!cards) return [];
  const byDay = new Map<string, { at: number; cards: AddedCard[]; seen: Set<string>; binders: Map<string, number>; fresh: boolean }>();
  for (const line of lines.slice(0, FRESH_PULLS_CARDS)) {
    const binderName = homeNames.get(line.homeId);
    const card = cards.get(line.cardId);
    if (!binderName || !card) continue;
    const day = localDay(line.addedAt);
    let batch = byDay.get(day);
    if (!batch) {
      batch = { at: line.addedAt, cards: [], seen: new Set(), binders: new Map(), fresh: false };
      byDay.set(day, batch);
    }
    const key = `${line.cardId}@${line.homeId}`;
    if (batch.seen.has(key)) continue;
    batch.seen.add(key);
    batch.cards.push({ ...toDash(card), binderName });
    batch.binders.set(binderName, (batch.binders.get(binderName) ?? 0) + 1);
    if (since === null || (typeof since === "number" && line.addedAt > since)) batch.fresh = true;
  }
  return [...byDay.entries()].map(([day, b]) => ({
    id: `pulls-${day}`,
    whenLabel: pullDayLabel(b.at, now),
    daysAgo: Math.max(0, daysBetween(day, localDay(now))),
    cards: b.cards,
    binders: [...b.binders.entries()].map(([name, count]) => ({ name, count })),
    sinceLastVisit: b.fresh,
  }));
}

/** The ids Fresh Pulls draws: the newest `FRESH_PULLS_CARDS` lines' cards. */
export function freshPullIds(lines: FreshPullsRaw["lines"] | undefined): CardId[] | null {
  if (!lines || lines.length === 0) return null;
  return lines.slice(0, FRESH_PULLS_CARDS).map((l) => l.cardId as CardId);
}

// ---------------------------------------------------------------------------
// New Listings: the cards that landed in a box lately
// ---------------------------------------------------------------------------

/** New Listings looks back as far as Fresh Pulls. */
export const NEW_LISTINGS_DAYS = FRESH_PULLS_DAYS;
/** At most this many of the newest lines are drawn (and hydrated). */
export const NEW_LISTINGS_CARDS = 24;

/**
 * New Listings from the box lines (newest first): each line once, in a box
 * the collector has (a line whose box is not on the list is left out), its
 * card hydrated (one not hydrated yet waits).
 */
export function newListingsOf(
  lines: NewListingsRaw["lines"],
  cards: CardsById | undefined,
  boxNames: ReadonlyMap<string, string>,
  now: number,
): NewListing[] {
  if (!cards) return [];
  return lines.slice(0, NEW_LISTINGS_CARDS).flatMap((line) => {
    const boxName = boxNames.get(line.homeId);
    const card = cards.get(line.cardId as CardId);
    if (!boxName || !card) return [];
    return [
      {
        ...toDash(card),
        lineId: line.id,
        quantity: line.quantity,
        priceCents: line.priceCents,
        boxId: line.homeId,
        boxName,
        daysAgo: Math.max(0, daysBetween(localDay(line.listedAt), localDay(now))),
      },
    ];
  });
}

/** The ids New Listings draws, or null when there are none. */
export function newListingIds(lines: NewListingsRaw["lines"] | undefined): CardId[] | null {
  if (!lines || lines.length === 0) return null;
  return lines.slice(0, NEW_LISTINGS_CARDS).map((l) => l.cardId as CardId);
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

/** Why a card was held back, as the dashboard says it (the Sync status tab's words, minus its "above"). */
export function heldBackReason(
  problem: { reason: SyncAlertsRaw["sets"][number]["cards"][number]["reason"]; detail?: string },
  platform: SyncAlertsRaw["sets"][number]["platform"],
): string {
  if (problem.reason === "noPrice") return "No price yet. Set one on the card, or a common price for the set.";
  return problemSentence(problem, false, platform);
}

/**
 * The sync status from its read: null when nothing is waiting and nothing is
 * wrong, so no section shows (the widget rule). A held-back card not
 * hydrated yet (or gone from the catalog) is still counted, just not named.
 */
export function syncStatusOf(raw: SyncAlertsRaw | undefined, cards: CardsById | undefined): SyncStatusData | null {
  if (!raw || (raw.pending.length === 0 && raw.sets.length === 0)) return null;
  return {
    pending: raw.pending.map((p) => ({ marketplace: p.platform as Marketplace, cards: p.cards, more: p.more })),
    problems: raw.sets.map((set) => ({
      id: `sync-${set.platform}-${set.variantId}`,
      marketplace: set.platform as Marketplace,
      setLabel: set.setLabel,
      failure: set.failed ? (set.message ?? "The last sync didn't go through.") : null,
      heldBack: set.heldBack,
      cards: set.cards.flatMap((c) => {
        const card = cards?.get(c.cardId as CardId);
        return card ? [{ card: toDash(card), reason: heldBackReason(c, set.platform), code: c.reason }] : [];
      }),
    })),
    more: raw.more,
  };
}

/** The card ids the sync status names, or null when there are none. */
export function syncCardIdsOf(raw: SyncAlertsRaw | undefined): CardId[] | null {
  const ids = raw ? raw.sets.flatMap((s) => s.cards.map((c) => c.cardId as CardId)) : [];
  return ids.length > 0 ? ids : null;
}

/**
 * The Checklists tab's place for the checklist an entry opens
 * (`app/collection/final/checklistParams.ts`): the set, then its variant type,
 * then an insert or parallel under it, then a parallel under an insert. Ids
 * only, the same path the collection store builds for a card's variant.
 */
export function checklistParamsOf(opens: NewSetRaw["opens"], setId: string): Record<string, string> {
  const out: Record<string, string> = { tab: "checklists", set: setId };
  if (opens.level === "variantType") {
    out.type = opens._id;
    return out;
  }
  out.type = opens.variantType?._id ?? opens._id;
  if (opens.level === "parallel" && opens.insert) {
    out.variant = opens.insert._id;
    out.sub = opens._id;
  } else {
    out.variant = opens._id;
  }
  return out;
}

/** A variant's own name, a parallel under an insert after its insert's: "Future Stars Gold". */
function variantNameOf(opens: NewSetRaw["opens"]): string {
  return opens.level === "parallel" && opens.insert ? `${opens.insert.name} ${opens.name}` : opens.name;
}

/**
 * New on NeonBinder from its read: a whole set's load named for the set, a
 * lone variant for the set and itself, each opening its checklist, its cover
 * card once hydrated (until then, none).
 */
export function newSetsOf(raw: readonly NewSetRaw[] | undefined, cards: CardsById | undefined): NewSet[] {
  return (raw ?? []).map((n) => {
    const cover = n.coverCardId ? cards?.get(n.coverCardId as CardId) : undefined;
    return {
      id: n.wholeSet ? n.set._id : `${n.set._id}:${n.opens._id}`,
      label: dashSetLabel({ season: n.set.season, name: n.set.name, brand: n.set.manufacturer?.name }),
      variant: n.wholeSet ? null : variantNameOf(n.opens),
      checklist: checklistParamsOf(n.opens, n.set._id),
      sport: n.set.sport?.name ?? null,
      cardCount: n.cardCount,
      cover: cover ? toDash(cover) : null,
    };
  });
}

/** `YYYY-MM-DD` of an instant, on this device's calendar. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Where `justCompleted` starts looking: the start of the oldest day the
 * window keeps, a day early so no time zone loses its last day (the window
 * itself is `recentCompletions`'s, by calendar day).
 */
export function completionWindowStart(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - JUST_COMPLETED_DAYS - 1);
  return d.getTime();
}

/** A finished checklist from the server, its cards hydrated; null until its last card is. */
export function completedChecklistOf(raw: CompletionRaw, cards: CardsById): CompletedChecklist | null {
  const last = cards.get(raw.lastCardId);
  if (!last) return null;
  // Named from the hydrated card's set, so the cheer says the set the way its
  // cards' titles do ("1993 Topps Finest"), whatever the server's label says.
  const label = setRefLabel(last.set);
  return {
    id: `done-${raw.setId}-base`,
    label,
    setLabel: label,
    checklistName: raw.checklistName,
    total: raw.total,
    cards: dashCardsOf(raw.cardIds, cards),
    lastCard: toDash(last),
    completedOn: raw.whenDay ?? localDay(raw.whenMs),
  };
}

/** The needed cards a set's board names: Want List cards first, then checklist order, at most `NEED_NAMED`. */
export function namedNeedsOf(board: SetBoardRaw, wanted: ReadonlySet<CardId>): CardId[] {
  const needed = board.cards.filter((c) => !c.owned).map((c) => c.cardId as CardId);
  return [...needed.filter((id) => wanted.has(id)), ...needed.filter((id) => !wanted.has(id))].slice(0, NEED_NAMED);
}

/**
 * A set on the board, from its base checklist (`dashboard.setBoard`). Null
 * when it has no base cards to light. Only the needs the board names are
 * drawn (`namedNeedsOf`, hydrated in `cards`); every bulb knows its card.
 */
export function buildingSetOf(
  set: SetRef,
  board: SetBoardRaw | null,
  cards: CardsById | undefined,
  wanted: ReadonlySet<CardId>,
): BuildingSet | null {
  if (!board || board.cards.length === 0) return null;
  const total = board.cards.length;
  const have = board.cards.filter((c) => c.owned).length;
  const named = namedNeedsOf(board, wanted);
  return {
    setId: set.id,
    setLabel: setRefLabel(set),
    have,
    total,
    need: total - have,
    percent: percentOf(have, total),
    neededNumbers: board.cards.filter((c) => !c.owned).map((c) => c.cardNumber),
    neededCards: cards ? dashCardsOf(named, cards) : [],
    baseBulbs: board.cards.map((c) => ({ cardNumber: c.cardNumber, owned: c.owned, cardId: c.cardId })),
    checklists: [{ name: "Base", kind: "base", have, total }],
  };
}

/**
 * Each binder's cards new since the last visit, newest first, each card
 * once (a card filed twice is one new card). A card not hydrated yet is
 * left out until it is.
 */
export function newCardsByHome(lines: NewSinceRaw["lines"], cards: CardsById | undefined): Map<string, DashCard[]> {
  const ids = new Map<string, CardId[]>();
  for (const line of lines) {
    const list = ids.get(line.homeId) ?? [];
    list.push(line.cardId);
    ids.set(line.homeId, list);
  }
  const out = new Map<string, DashCard[]>();
  if (!cards) return out;
  for (const [homeId, list] of ids) out.set(homeId, dashCardsOf(list, cards));
  return out;
}

/** The smart binders on the shelf, as the screen's summaries. A percent only where the rule names a checklist. */
export function smartBindersOf(binders: readonly ShelfBinder[]): SmartBinderSummary[] {
  return binders
    .filter((b) => b.kind === "smart")
    .map((b) => ({
      id: b.id,
      name: b.name,
      ruleText: b.ruleText ?? "",
      cardCount: b.cardCount,
      newCount: b.newCards.length,
      newCards: b.newCards,
      ...(b.checklist ? { checklist: b.checklist } : {}),
    }));
}

/** The could-fit ids worth hydrating: each binder's first `COULD_FIT_PREVIEW`, the ones its strip names. */
export function couldFitPreviewIds(raw: ReadonlyMap<string, CouldFitRaw | null> | undefined): CardId[] {
  const ids: CardId[] = [];
  if (raw) for (const answer of raw.values()) if (answer) ids.push(...answer.cardIds.slice(0, COULD_FIT_PREVIEW));
  return ids;
}

/**
 * Each smart binder's could-fit cards: the preview, in the server's order
 * (its fits'), hydrated (a card not hydrated yet waits; one gone from the
 * catalog is left out of the count too), and how many there are. A binder
 * with none, or no honest answer, has no entry.
 */
export function couldFitByBinder(
  raw: ReadonlyMap<string, CouldFitRaw | null> | undefined,
  cards: CardsById | undefined,
): Map<string, CouldFitCards> {
  const out = new Map<string, CouldFitCards>();
  if (!raw || !cards) return out;
  for (const [id, answer] of raw) {
    if (!answer || answer.cardIds.length === 0) continue;
    const preview = answer.cardIds.slice(0, COULD_FIT_PREVIEW) as CardId[];
    const shown = dashCardsOf(preview, cards);
    const gone = preview.filter((c) => !cards.has(c)).length;
    out.set(id, { cards: shown, count: answer.cardIds.length - gone, more: answer.more });
  }
  return out;
}

/**
 * The Add cards tab's `?run=` (`RUN_PARAM` in
 * `app/collection/final/intake/RealAddCardsTab.tsx`), spelled here so the
 * dashboard does not pull the whole tab into its bundle. A test keeps the two equal.
 */
export const ADD_CARDS_RUN_PARAM = "run";

/** Where a run is finished: the Add cards tab on its side's screen, opened on the run. */
export function runHrefOf(side: IntakeUpload["side"], runId: string): string {
  return `/${side}?${new URLSearchParams({ tab: "add", [ADD_CARDS_RUN_PARAM]: runId })}`;
}

/**
 * When a run last moved, as its hopper block says it when another open run
 * has the same name: the time on the day itself, then "yesterday", then days
 * ago, on this device's calendar.
 */
export function lastScanLabel(at: number, now: number): string {
  const days = daysBetween(localDay(at), localDay(now));
  if (days <= 0) return `Last scan ${new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  if (days === 1) return "Last scan yesterday";
  return `Last scan ${days} days ago`;
}

/**
 * The hopper from `dashboard.intake`: every open scan is in intake (a best
 * guess waiting on a yes, or one not identified yet), and the server returns
 * only the runs that still hold one. Each run's thumbnails are its guesses
 * whose card is hydrated. Nothing open and nothing sorted: empty, so the
 * hopper stays hidden.
 */
export function intakeOf(raw: IntakeRaw | undefined, cards: CardsById | undefined, now: number): IntakeInProgress {
  if (!raw) return NO_INTAKE;
  const total = raw.needsYou + raw.unidentified;
  if (total === 0 && raw.sortedThisWeek === 0 && raw.sortedAllTime === 0) return NO_INTAKE;
  return {
    total,
    needsYou: raw.needsYou,
    unidentified: raw.unidentified,
    uploads: raw.runs.map((r) => ({
      id: r.runId,
      name: r.homeName,
      needsYou: r.needsYou,
      unidentified: r.unidentified,
      side: r.side,
      href: runHrefOf(r.side, r.runId),
      lastScan: lastScanLabel(r.lastActivityAt, now),
      guesses: r.guesses.flatMap((id) => {
        const card = cards?.get(id);
        return card ? [toDash(card)] : [];
      }),
    })),
    sortedThisWeek: raw.sortedThisWeek,
    sortedAllTime: raw.sortedAllTime,
    sortedAllTimeMore: raw.sortedAllTimeMore,
  };
}

/** A platform's status word in plain case: "READY_TO_SHIP" reads "Ready to ship". The word itself is never changed. */
export function statusWordsOf(status: string): string {
  const words = status.trim().toLowerCase().replace(/[_\s]+/g, " ");
  return words ? words[0].toUpperCase() + words.slice(1) : status;
}

/** Whole calendar days since the order date, on this device's calendar; never below 0. */
export function daysSinceSold(orderDate: number, now: number): number {
  return Math.max(0, daysBetween(localDay(orderDate), localDay(now)));
}

type SaleRaw = SalesRaw["orders"][number];

/**
 * One order line. A line with no card, or a card that is not in the catalog
 * any more, is unmatched: never a guess at which card it was. An oversold
 * line names how many sold and how many the boxes held.
 */
export function saleLineOf(line: SaleRaw["lines"][number], cards: CardsById): SaleLine {
  const card: Card | undefined = line.cardId ? cards.get(line.cardId) : undefined;
  if (!card) return { card: null, quantity: line.quantity, problem: { kind: "unmatched" } };
  if (line.problem === "oversold") {
    const short = line.shortBy ?? line.quantity;
    return {
      card: toDash(card),
      quantity: line.quantity,
      problem: { kind: "oversold", sold: line.quantity, inBoxes: Math.max(0, line.quantity - short) },
    };
  }
  return { card: toDash(card), quantity: line.quantity };
}

/** One order still to ship, as Out the Door draws it. */
export function unshippedSaleOf(order: SaleRaw, cards: CardsById, now: number): UnshippedSale {
  const lines = order.lines.map((l) => saleLineOf(l, cards));
  return {
    id: order.id,
    marketplace: order.platform,
    orderNumber: order.orderNo,
    daysSinceSold: daysSinceSold(order.orderDate, now),
    statusText: statusWordsOf(order.status),
    lines,
    cardCount: order.cardCount,
    firstCard: lines.find((l) => l.card)?.card ?? null,
    hasProblem: order.problemPastCut || lines.some((l) => l.problem),
  };
}

/** The sales panel: null for an account that does not sell (no sales section); else its orders to ship, oldest first. */
export function salesDataOf(raw: SalesRaw, cards: CardsById | undefined, now: number): SalesData | null {
  if (!raw.dealer) return null;
  const orders = [...raw.orders].sort((a, b) => a.orderDate - b.orderDate);
  return { unshipped: orders.map((o) => unshippedSaleOf(o, cards ?? new Map(), now)) };
}

/** The card ids the orders to ship name, or null when there are none. */
export function saleCardIdsOf(raw: SalesRaw | undefined): CardId[] | null {
  const ids = raw ? raw.orders.flatMap((o) => o.lines.flatMap((l) => (l.cardId ? [l.cardId as CardId] : []))) : [];
  return ids.length > 0 ? ids : null;
}

/** What the page draws beyond the shelf. Each part absent reads as empty. */
export interface DashboardExtras {
  wantList?: WantCard[];
  tradePile?: TradePile;
  unlistedBoxes?: UnlistedBox[];
  justCompleted?: CompletedSet | null;
  building?: BuildingSet[];
  smartBinders?: SmartBinderSummary[];
  /** Null or absent: the account does not sell, so no sales section. */
  sales?: SalesData | null;
  intake?: IntakeInProgress;
  /** Fresh Pulls, newest day first; absent or empty, no Fresh Pulls section. */
  additions?: AdditionBatch[];
  /** New Listings, newest first; absent or empty, no New Listings section. */
  newListings?: NewListing[];
  /** The sync status; null or absent, no sync status section. */
  syncStatus?: SyncStatusData | null;
  /** The boxes in use, for the third shelf; absent or empty, it holds binders. */
  shelfBoxes?: ShelfBox[];
  newSets?: NewSet[];
  /** How many boxes the collector has (Unsorted counts once it exists); absent reads as none. */
  boxes?: number;
}

/** The whole page from the shelf, the summary and the extras. Pure: the hook below only gathers its inputs. */
export function realDashboardData(input: { binders: ShelfBinder[]; summary: CollectionSummary } & DashboardExtras): DashboardData {
  const { binders, summary } = input;
  return {
    sales: input.sales ?? null,
    additions: input.additions ?? [],
    newListings: input.newListings ?? [],
    syncStatus: input.syncStatus ?? null,
    shelfBoxes: input.shelfBoxes ?? [],
    newSets: input.newSets ?? [],
    building: input.building ?? [],
    justCompleted: input.justCompleted ?? null,
    smartBinders: input.smartBinders ?? [],
    wantList: input.wantList ?? [],
    intake: input.intake ?? NO_INTAKE,
    unlistedBoxes: input.unlistedBoxes ?? [],
    tradePile: input.tradePile ?? NO_TRADE,
    totals: { cards: summary.cards, binders: binders.length, boxes: input.boxes ?? 0, exact: summary.exact },
    binders,
  };
}

/**
 * The signed-in dashboard. `undefined` while the shelf, the summary or the
 * chase (the newest wants and their cards) loads, so the Want List never
 * reads as empty while it is only loading; and until the sales read answers
 * (with the cards its orders name), so the sales section never pops in late
 * nor says "All shipped" while loading. The open binder's pockets fill in
 * when its copies and cards arrive; until then its page stands empty. The
 * trade pile's count is on the shelf; its few cards fill in when they arrive.
 * The boards, the cheer, the smart binders' percents and the news since the
 * last visit fill in as their reads answer.
 *
 * Every read here is bounded. Subscribed: the shelf, the summary, the wants
 * (the Want List's own cap), the building sets, at most `CHASE_CAP` want
 * cards, the first `TRADE_PREVIEW` trade copies and their cards, the open
 * binder's copies, the lines new since the last visit (at most 100), and
 * the cards the boards, the cheer and the news draw (a few each). Read once
 * on mount: the completions, at most `BOARD_SETS` base checklists,
 * `SMART_CHECKLISTS` binder fits counted and as many could-fit reads, the
 * intake summary and the sales. Subscribed for them: the cards the orders
 * to ship name (at most 10 orders of 12 lines), each could-fit strip's
 * first `COULD_FIT_PREVIEW` cards and the hopper's few guesses (with the
 * extras' hydration).
 */
export function useRealDashboard(): DashboardData | undefined {
  const containers = useContainers();
  const summary = useSummary();
  const wants = useWants();
  const building = useBuildingSets();
  const [params] = useSearchParams();
  const [now] = useState(() => Date.now());

  const shelf = useMemo(() => (containers ? bindersOf(containers) : undefined), [containers]);

  // Only a binder on this shelf is read: a stale or foreign id in the URL opens nothing.
  const asked = params.get(BINDER_PARAM);
  const openId = asked && shelf?.some((c) => c.id === asked) ? asked : null;

  const listed = useContainerCopies(openId);
  const cardIds = useMemo(() => (openId && listed ? listed.copies.map((c) => c.cardId) : null), [openId, listed]);
  const cards = useCardMap(cardIds);

  const chase = useMemo(() => (wants ? chaseOf(wants) : undefined), [wants]);
  const chaseCards = useCardMap(useMemo(() => chase?.map((w) => w.cardId) ?? null, [chase]));
  // The board stars and leads with the chase's cards (the screen's `wanted`), so its named needs do too.
  const wanted = useMemo(() => new Set<CardId>(chase?.map((w) => w.cardId) ?? []), [chase]);

  // The pile's first page is a small indexed read; its cards are hydrated only when the shelf counts any.
  const trade = systemContainer(containers, "trade");
  const tradeCount = trade?.count?.copies ?? 0;
  const tradeListed = useTradeCopies({ limit: TRADE_PREVIEW });
  const tradeIds = useMemo(
    () => (tradeCount > 0 && tradeListed ? tradeListed.copies.slice(0, TRADE_PREVIEW).map((c) => c.cardId) : null),
    [tradeCount, tradeListed],
  );
  const tradeCards = useCardMap(tradeIds);

  // Since the last visit: stamped on mount, then the lines touched since.
  const since = useVisitSince();
  const fresh = useNewSince(since);
  // Fresh Pulls: the last two weeks' filings, subscribed, so an add shows at once.
  const pulls = useFreshPullLines(useMemo(() => freshPullsWindowStart(now), [now]));
  const pullCards = useCardMap(useMemo(() => freshPullIds(pulls?.lines), [pulls]));
  // New Listings: the last two weeks' cards into a box, subscribed, so a card put up for sale shows at once.
  const listingLines = useNewListingLines(useMemo(() => freshPullsWindowStart(now), [now]));
  const listingCards = useCardMap(useMemo(() => newListingIds(listingLines?.lines), [listingLines]));
  // The sync status at the top, and the cards it names (their own hydration, so it settles once).
  const syncRaw = useSyncAlertsRaw();
  const syncIds = useMemo(() => syncCardIdsOf(syncRaw), [syncRaw]);
  const syncCards = useCardMap(syncIds);
  // New on NeonBinder: the catalog's newest sets, each with its cover card.
  const newSetsRaw = useNewSets();
  const coverIds = useMemo(() => {
    const ids = (newSetsRaw ?? []).flatMap((n) => (n.coverCardId ? [n.coverCardId as CardId] : []));
    return ids.length > 0 ? ids : null;
  }, [newSetsRaw]);
  const coverCards = useCardMap(coverIds);

  // The board's sets, the completions and the smart binders' checklists: each read once.
  const boardSets = useMemo(() => building?.slice(0, BOARD_SETS), [building]);
  const boards = useSetBoards(useMemo(() => boardSets?.map((s) => s.id) ?? null, [boardSets]));
  const completions = useJustCompletedRaw(useMemo(() => completionWindowStart(now), [now]));
  const smartIds = useMemo(
    () => shelf?.filter((c) => c.smartRule).slice(0, SMART_CHECKLISTS).map((c) => c.id) ?? null,
    [shelf],
  );
  const smartCounts = useSmartChecklists(smartIds);
  const couldFitRaw = useCouldFit(smartIds);
  const intakeRaw = useIntakeRaw();

  // The sales section's gate, and the cards its orders name (their own hydration, so it settles once).
  const salesRaw = useSalesRaw();
  const saleIds = useMemo(() => saleCardIdsOf(salesRaw), [salesRaw]);
  const saleCards = useCardMap(saleIds);

  // One hydration for what the extras draw: each board's named needs, the cheers' cards, the news.
  const extraIds = useMemo(() => {
    const ids: CardId[] = [];
    if (boards) for (const board of boards.values()) if (board) ids.push(...namedNeedsOf(board, wanted));
    for (const done of completions ?? []) ids.push(done.lastCardId, ...done.cardIds);
    for (const line of fresh?.lines ?? []) ids.push(line.cardId);
    ids.push(...couldFitPreviewIds(couldFitRaw));
    for (const run of intakeRaw?.runs ?? []) ids.push(...run.guesses);
    return ids.length > 0 ? ids : null;
  }, [boards, wanted, completions, fresh, couldFitRaw, intakeRaw]);
  const extraCards = useCardMap(extraIds);

  const newByHome = useMemo(() => newCardsByHome(fresh?.lines ?? [], extraCards), [fresh, extraCards]);
  const fitByBinder = useMemo(() => couldFitByBinder(couldFitRaw, extraCards), [couldFitRaw, extraCards]);

  const openPockets = useMemo(() => {
    if (!openId || !listed || !cards) return null;
    const freshIds = new Set((newByHome.get(openId) ?? []).map((c) => c.id));
    return pocketsOfPages(binderPages({ binderId: openId, copies: listed.copies, cards, followed: null }), freshIds);
  }, [openId, listed, cards, newByHome]);

  return useMemo(() => {
    if (!containers || !shelf || !summary || !chase || !chaseCards) return undefined;
    if (!salesRaw || (saleIds && !saleCards)) return undefined;
    // The sync status leads the page: wait for it, so it never pops in above everything.
    if (!syncRaw || (syncIds && !syncCards)) return undefined;
    const boxes = boxesOf(containers);
    const binders = shelf.map((c) =>
      shelfBinderOf(c, c.id === openId && openPockets ? openPockets : [], {
        newCards: newByHome.get(c.id),
        checklist: smartCounts?.get(c.id) ?? null,
        couldFit: fitByBinder.get(c.id),
      }),
    );
    const sets = (boardSets ?? []).flatMap((set) => {
      const made = buildingSetOf(set, boards?.get(set.id) ?? null, extraCards, wanted);
      return made ? [made] : [];
    });
    const done = extraCards
      ? (completions ?? []).flatMap((raw) => {
          const made = completedChecklistOf(raw, extraCards);
          return made ? [made] : [];
        })
      : [];
    return realDashboardData({
      binders,
      summary,
      wantList: wantCardsOf(chase, containers, chaseCards),
      tradePile: tradePileOf(trade, tradeListed, tradeCards),
      unlistedBoxes: unlistedBoxesOf(containers),
      boxes: boxesInUseOf(containers),
      justCompleted: justCompletedOf(done, localDay(now)),
      building: sets,
      smartBinders: smartBindersOf(binders),
      sales: salesDataOf(salesRaw, saleCards, now),
      intake: intakeOf(intakeRaw, extraCards, now),
      additions: freshPullsOf(pulls?.lines ?? [], pullCards, new Map(shelf.map((c) => [c.id, c.name])), since, now),
      newSets: newSetsOf(newSetsRaw, coverCards),
      newListings: newListingsOf(listingLines?.lines ?? [], listingCards, new Map(boxes.map((b) => [b.id, b.name])), now),
      syncStatus: syncStatusOf(syncRaw, syncCards),
      shelfBoxes: shelfBoxesOf(containers),
    });
  }, [
    listingLines,
    listingCards,
    syncRaw,
    syncIds,
    syncCards,
    pulls,
    pullCards,
    since,
    newSetsRaw,
    coverCards,
    containers,
    shelf,
    summary,
    chase,
    chaseCards,
    openId,
    openPockets,
    trade,
    tradeListed,
    tradeCards,
    newByHome,
    smartCounts,
    boardSets,
    boards,
    extraCards,
    wanted,
    completions,
    now,
    salesRaw,
    saleIds,
    saleCards,
    fitByBinder,
    intakeRaw,
  ]);
}
