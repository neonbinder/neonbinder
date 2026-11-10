/**
 * NEO-464 — the signed-in dashboard's own reads and its one write.
 *
 * Everything else on `/dashboard` comes through the collection store
 * (`app/collection/final/data/convexStore.ts`). What lives here is what the
 * store has no answer for, each read bounded, and most of them read ONCE on
 * mount (`useConvex().query`), never subscribed: a subscribed query must stay
 * small (CLAUDE.md, NEO-392), and these walk a checklist or a binder's fits.
 *
 * - `justCompleted` (read once): the base checklists the collector finished
 *   lately. Nothing stores a completion, so it is worked out from the copies.
 * - `setBoard` (read once, one set per call): a set's base checklist as
 *   bulbs, each lit or not, for the scoreboard.
 * - `smartChecklist` (read once, one binder per call): how much of a smart
 *   binder's checklist is filed in it, from its stored fits.
 * - `newSince` (subscribed, at most `NEW_SINCE_LINES` + 1 lines): the
 *   collection lines filed or moved since the last visit (never an add or
 *   an edit).
 * - `markVisit` (mutation): reads the last visit, then stamps this one.
 * - `couldFit` (read once, one smart binder per call): the cards the
 *   collector holds in another binder that the binder's rule takes in, at
 *   most `COULD_FIT_CARDS`, from its stored fits' `held` mark.
 * - `intake` (read once): what is still in intake across the collector's
 *   recent runs, counted from their match rows, each run with the side its
 *   home is on (a binder's run finishes on Collection, a box's on Inventory).
 * - `sales` (read once): whether the account sells (the sales section shows), and
 *   its newest orders still to ship, at most `SALES_SHOWN`.
 *
 * NB data only, except `sales`: an order's status is the platform's own word
 * (NB keeps no shipped state), read through `listingSales.awaitingShipment`.
 * The sales gate never names a platform: any listing platform connected,
 * or any order stored.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireSignedIn } from "./auth";
import { MAX_CANDIDATES, parallelReader } from "./binderRules";
import { HomeSides, MAX_VARIANT_COPIES, copyCardIdValidator, sideOfContainer, sideValidator, type Side } from "./collection";
import { MAX_DRILL_ITEMS, MAX_VARIANT_CARDS } from "./collectionCatalog";
import { CatalogReader } from "./lib/catalogView";
import { awaitingShipment } from "./listingSales";
import { LISTING_PLATFORMS, listingCredentialOf } from "./listingOutbox";
import { listingPlatformValidator, saleItemProblemValidator } from "./schema";
import { variantTypeKind } from "./variantRole";
import { MAX_SORTED_LINES, type StoredRule } from "../lib/collection/binder-rule";

type Ctx = Pick<QueryCtx, "db">;
type CopyRow = Doc<"collectionCopies">;
type CardRow = Doc<"cardChecklist">;
type OptionRow = Doc<"selectorOptions">;

// ───────────────────────────────────────────────────────────────────────────
// Limits
// ───────────────────────────────────────────────────────────────────────────

/** Recently touched lines `justCompleted` looks through for the sets to check. */
export const RECENT_LINES = 400;
/** Sets `justCompleted` checks, the most recently touched first. */
export const COMPLETION_SETS = 6;
/** Completions returned, newest first (the dashboard keeps three). */
export const COMPLETIONS_RETURNED = 3;
/** Card ids a completion carries for the cheer's thumbnails, newest arrival first. */
export const CHEER_CARDS = 9;
/** Documents `justCompleted` may read across every set it checks. */
export const COMPLETION_READ_BUDGET = 10_000;
/** Lines `newSince` returns, newest first. */
export const NEW_SINCE_LINES = 100;
/** Two dashboard opens closer than this are one visit. */
export const VISIT_GAP_MS = 30 * 60 * 1000;
/** Within one visit, a reopen closer than this to the last stamp writes nothing. */
export const STAMP_MIN_MS = 60 * 1000;
/** Cards `couldFit` returns for one smart binder, in its fits' order. */
export const COULD_FIT_CARDS = 20;
/** Fits rows `couldFit` looks through for held cards. */
export const COULD_FIT_SCAN = 1000;
/** Held fits `couldFit` checks against the binder itself and its declines. */
export const COULD_FIT_CHECKS = 60;
/** A card's lines read to see whether one is filed in the binder (`collection.MAX_LINES_PER_CARD`). */
const LINES_PER_CARD = 200;
/** Recent intake runs `intake` looks at, newest activity first (`intakeRuns.listMyIntakeRuns`'s cap). */
export const INTAKE_RUNS = 20;
/** A run finished this long ago still shows its upload; an unfinished one always does. */
export const INTAKE_RECENT_MS = 7 * 86_400_000;
/** Match rows read from one run (`intakeRuns.INTAKE_SETTLE_SCAN`). */
export const INTAKE_RUN_ROWS = 1000;
/** Match rows `intake` reads across every run. */
export const INTAKE_READ_BUDGET = 5000;
/** Scans named in the hopper's preview: best guesses, then ones with no guess. */
export const INTAKE_PREVIEW_GUESSES = 3;
export const INTAKE_PREVIEW_UNKNOWN = 4;
/** Orders `sales` looks through, newest first. */
export const SALES_SCAN = 100;
/** Orders still to ship `sales` returns, newest first. */
export const SALES_SHOWN = 10;
/** Lines of one order returned (the rest are counted). */
export const SALE_LINES = 12;

// ───────────────────────────────────────────────────────────────────────────
// Pure rules (tested in dashboard.test.ts)
// ───────────────────────────────────────────────────────────────────────────

/** When a copy came in. */
export interface Arrival {
  /** For ordering: its acquired day at noon UTC, else when NB first saw the line. */
  ms: number;
  /** Its acquired day (`YYYY-MM-DD`) when the collector gave one, else null. */
  day: string | null;
}

/**
 * A copy's arrival: the day the collector says they got it (`acquiredOn`)
 * when given, else when the line was first written (`_creationTime`, which a
 * fold or an edit never moves; `lastUpdated` does). A day sits at noon UTC so
 * it orders sensibly against a timestamp; the day itself is kept so the page
 * never shifts it across a time zone.
 */
export function arrivalOf(copy: { acquiredOn?: string; _creationTime: number }): Arrival {
  const m = copy.acquiredOn ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(copy.acquiredOn) : null;
  if (m) return { ms: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12), day: copy.acquiredOn! };
  return { ms: copy._creationTime, day: null };
}

/** A finished base checklist: when its last card came in, and its cards by arrival. */
export interface BaseCompletion {
  whenMs: number;
  whenDay: string | null;
  lastCardId: string;
  /** Every card of the checklist, the last to arrive first. */
  byArrival: string[];
}

/**
 * Is the base checklist `checklist` (its regular cards' ids, in order) held
 * whole by `copies`, and when was it finished? A card is held from its
 * EARLIEST copy (a second copy later completes nothing), and the checklist
 * is finished when its last card was first held. A copy of a card outside
 * the checklist (a parallel, an image variation, another set) counts for
 * nothing. Null when any card is missing, or the checklist is empty. A tie
 * on the finishing moment goes to the card later in the checklist.
 */
export function baseCompletion(
  checklist: readonly string[],
  copies: ReadonlyArray<{ cardId: string; acquiredOn?: string; _creationTime: number }>,
): BaseCompletion | null {
  if (checklist.length === 0) return null;
  const first = new Map<string, Arrival>();
  for (const copy of copies) {
    const at = arrivalOf(copy);
    const known = first.get(copy.cardId);
    if (!known || at.ms < known.ms) first.set(copy.cardId, at);
  }
  const arrivals: Array<{ cardId: string; at: Arrival; index: number }> = [];
  for (let index = 0; index < checklist.length; index++) {
    const at = first.get(checklist[index]);
    if (!at) return null;
    arrivals.push({ cardId: checklist[index], at, index });
  }
  arrivals.sort((a, b) => b.at.ms - a.at.ms || b.index - a.index);
  const last = arrivals[0];
  return {
    whenMs: last.at.ms,
    whenDay: last.at.day,
    lastCardId: last.cardId,
    byArrival: arrivals.map((a) => a.cardId),
  };
}

export type DashboardVisit = { seenAt: number; sinceAt?: number };

/**
 * The visit rule. A dashboard open within `VISIT_GAP_MS` of the last one
 * continues that visit: "new" still starts where it started, so Back to the
 * dashboard keeps its news. A later open starts a new visit whose "new"
 * starts at the last open. The first open ever has nothing to compare
 * (`since` null). `write` is false when the stored row needs no change
 * (a reopen within `STAMP_MIN_MS`, or a clock that ran backwards).
 */
export function nextVisit(
  stored: DashboardVisit | undefined,
  now: number,
): { visit: DashboardVisit; since: number | null; write: boolean } {
  if (!stored) return { visit: { seenAt: now }, since: null, write: true };
  const gap = now - stored.seenAt;
  if (gap < VISIT_GAP_MS) {
    const since = stored.sinceAt ?? null;
    if (gap < STAMP_MIN_MS) return { visit: stored, since, write: false };
    return { visit: { seenAt: now, ...(since !== null ? { sinceAt: since } : {}) }, since, write: true };
  }
  return { visit: { seenAt: now, sinceAt: stored.seenAt }, since: stored.seenAt, write: true };
}

/**
 * Does a smart rule name a checklist, so every card it can match sits in
 * the sets it names? All-of: one of its (not turned around) terms is a set.
 * Any-of: every term is a set. A player, team or brand binder has no
 * checklist and never shows a percent.
 */
export function ruleNamesChecklist(rule: Pick<StoredRule, "match" | "terms">): boolean {
  if (rule.match === "all") return rule.terms.some((t) => !t.negate && t.test.kind === "set");
  return rule.terms.length > 0 && rule.terms.every((t) => !t.negate && t.test.kind === "set");
}

/**
 * A smart binder's checklist, counted the way its empty slots are drawn
 * (`binderRules.binderNeeds`): every fit, except a parallel's while the
 * binder holds no card of that parallel. `have` is the fits filed in it.
 */
export function smartChecklistCount(
  fits: ReadonlyArray<{ cardId: string; variantId: string }>,
  here: ReadonlySet<string>,
  parallels: ReadonlySet<string>,
): { have: number; total: number } {
  const holds = new Set<string>();
  for (const fit of fits) if (here.has(fit.cardId)) holds.add(fit.variantId);
  let have = 0;
  let total = 0;
  for (const fit of fits) {
    if (here.has(fit.cardId)) {
      have += 1;
      total += 1;
    } else if (holds.has(fit.variantId) || !parallels.has(fit.variantId)) {
      total += 1;
    }
  }
  return { have, total };
}

/** A match row as `intakeRunTally` reads it. */
export interface IntakeRowFacts {
  _id: string;
  frontIndex: number;
  cardId?: string;
  savedAt?: number;
  setAside?: boolean;
}

/** One run's intake, counted from its match rows. */
export interface IntakeRunTally {
  /** Scans (pairs) the run holds. */
  scans: number;
  /** Saved or set aside: out of intake. */
  done: number;
  /** Still open with a best guess: waiting on the collector's yes. */
  needsYou: number;
  /** Still open with no guess: nothing identified them yet. */
  unidentified: number;
  /** The first open scans with a guess, in scan order, at most `INTAKE_PREVIEW_GUESSES`. */
  guesses: Array<{ id: string; cardId: string }>;
  /** The first open scans without one, in scan order, at most `INTAKE_PREVIEW_UNKNOWN`. */
  unknown: string[];
}

/**
 * A run's intake from its match rows. A scan is out of intake once it is
 * saved or set aside; an open one with a card named (`cardId`, the matcher's
 * or the collector's pick) waits on a yes, an open one with none is not
 * identified yet. Photos still being processed have no match row yet, so
 * they are not counted here.
 */
export function intakeRunTally(rows: readonly IntakeRowFacts[]): IntakeRunTally {
  const ordered = [...rows].sort((a, b) => a.frontIndex - b.frontIndex);
  const out: IntakeRunTally = { scans: rows.length, done: 0, needsYou: 0, unidentified: 0, guesses: [], unknown: [] };
  for (const row of ordered) {
    if (row.savedAt !== undefined || row.setAside === true) {
      out.done += 1;
    } else if (row.cardId) {
      out.needsYou += 1;
      if (out.guesses.length < INTAKE_PREVIEW_GUESSES) out.guesses.push({ id: row._id, cardId: row.cardId });
    } else {
      out.unidentified += 1;
      if (out.unknown.length < INTAKE_PREVIEW_UNKNOWN) out.unknown.push(row._id);
    }
  }
  return out;
}

/**
 * Does the run show in the hopper? While any scan is still open, always;
 * a finished one only when it was active within `INTAKE_RECENT_MS`.
 */
export function intakeRunShows(tally: Pick<IntakeRunTally, "scans" | "done">, lastActivityAt: number, now: number): boolean {
  if (tally.scans === 0) return false;
  return tally.done < tally.scans || now - lastActivityAt <= INTAKE_RECENT_MS;
}

/**
 * The sales section's gate: the account sells when it has a listing
 * platform connected or any order stored. Which platform never matters.
 */
export function isDealer(connected: readonly boolean[], anyOrder: boolean): boolean {
  return anyOrder || connected.some(Boolean);
}

type SaleItemFacts = Pick<Doc<"marketplaceSales">["items"][number], "cardId" | "quantity" | "problem" | "shortBy">;

/**
 * One order's lines for Out the Door: at most `SALE_LINES`, in the order's
 * own order, with its card count over every line and whether a line past
 * the cut has a problem. A line NB could not tie to a card (no `cardId`, a
 * link mismatch, or one the poll called unmatched) carries no card and is
 * marked unmatched: never a guess.
 */
export function saleLinesOf(items: readonly SaleItemFacts[]): {
  lines: Array<{ cardId?: Id<"cardChecklist">; quantity: number; problem?: SaleItemFacts["problem"]; shortBy?: number }>;
  cardCount: number;
  problemPastCut: boolean;
} {
  const lines = items.slice(0, SALE_LINES).map((item) => {
    const tied = item.cardId !== undefined && item.problem !== "linkMismatch" && item.problem !== "unmatched";
    const problem = item.problem ?? (tied ? undefined : ("unmatched" as const));
    return {
      ...(tied ? { cardId: item.cardId } : {}),
      quantity: item.quantity,
      ...(problem ? { problem } : {}),
      ...(item.shortBy !== undefined ? { shortBy: item.shortBy } : {}),
    };
  });
  return {
    lines,
    cardCount: items.reduce((n, item) => n + item.quantity, 0),
    problemPastCut: items.slice(SALE_LINES).some((item) => item.problem !== undefined || item.cardId === undefined),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Reads shared by the queries
// ───────────────────────────────────────────────────────────────────────────

/**
 * The set's Base type (its title is its kind, `variantRole`). Exactly one
 * per set; anything else (none, or a set breaking that rule) is null: never
 * a guess at which one is the base.
 */
async function baseOf(ctx: Ctx, setId: Id<"selectorOptions">): Promise<OptionRow | null> {
  const types = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) => q.eq("level", "variantType").eq("parentId", setId))
    .take(MAX_DRILL_ITEMS);
  const bases = types.filter((t) => variantTypeKind(t) === "base");
  return bases.length === 1 ? bases[0] : null;
}

/** A base type's regular cards (no image variation), in checklist order. */
async function baseCards(ctx: Ctx, baseId: Id<"selectorOptions">): Promise<{ cards: CardRow[]; read: number; truncated: boolean }> {
  const rows = await ctx.db
    .query("cardChecklist")
    .withIndex("by_selector_option_and_sort", (q) => q.eq("selectorOptionId", baseId))
    .take(MAX_VARIANT_CARDS + 1);
  const truncated = rows.length > MAX_VARIANT_CARDS;
  const cards = rows.slice(0, MAX_VARIANT_CARDS).filter((c) => !c.variationOfCardId);
  return { cards, read: rows.length, truncated };
}

/** The owner's collection lines (never a box's) in one set's base type, at most `MAX_VARIANT_COPIES`. */
async function baseLines(
  ctx: Ctx,
  ownerId: string,
  setId: Id<"selectorOptions">,
  baseId: Id<"selectorOptions">,
  sides: HomeSides,
): Promise<{ lines: CopyRow[]; read: number; truncated: boolean }> {
  const rows = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_set_variant", (q) => q.eq("ownerId", ownerId).eq("setId", setId).eq("variantId", baseId))
    .take(MAX_VARIANT_COPIES + 1);
  const truncated = rows.length > MAX_VARIANT_COPIES;
  const lines = await sides.keep(rows.slice(0, MAX_VARIANT_COPIES), "collection");
  return { lines, read: rows.length, truncated };
}

function setLabelOf(set: { season: string; name: string }): string {
  return `${set.season} ${set.name}`.trim();
}

// ───────────────────────────────────────────────────────────────────────────
// Queries
// ───────────────────────────────────────────────────────────────────────────

const completionValidator = v.object({
  setId: v.id("selectorOptions"),
  /** "2024 Topps Chrome". */
  setLabel: v.string(),
  /** Always null: only a set's base checklist is checked today. */
  checklistName: v.null(),
  /** Regular cards in the base checklist. */
  total: v.number(),
  /** When its last card came in (see `arrivalOf`). */
  whenMs: v.number(),
  /** That card's acquired day, when the collector gave one. */
  whenDay: v.union(v.string(), v.null()),
  lastCardId: v.id("cardChecklist"),
  /** At most `CHEER_CARDS` of its cards, the last to arrive first. */
  cardIds: v.array(v.id("cardChecklist")),
});

/**
 * The base checklists the caller finished at or after `sinceMs`, newest
 * first, at most `COMPLETIONS_RETURNED`. Read once on mount, never
 * subscribed.
 *
 * Finished: every regular card of the set's Base type is held, on the
 * collection side (a box's copy is for sale, not in the collection). When:
 * see `baseCompletion`.
 *
 * Bounded: a checklist finished since `sinceMs` was finished by a line
 * written since then (a line's arrival is never later than its writing), so
 * only the sets of the newest `RECENT_LINES` lines touched since `sinceMs`
 * are checked, at most `COMPLETION_SETS` of them. A set whose stored base
 * count is more than the distinct cards held is skipped before its
 * checklist is read; each checklist is read at most once, and the whole
 * call stops at `COMPLETION_READ_BUDGET` documents.
 */
export const justCompleted = query({
  args: { sinceMs: v.number() },
  returns: v.array(completionValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const recent = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_lastUpdated", (q) => q.eq("ownerId", ownerId).gte("lastUpdated", args.sinceMs))
      .order("desc")
      .take(RECENT_LINES);
    const setIds: Array<Id<"selectorOptions">> = [];
    for (const line of recent) {
      if (line.setId && !setIds.includes(line.setId)) setIds.push(line.setId);
      if (setIds.length >= COMPLETION_SETS) break;
    }

    const sides = new HomeSides(ctx, ownerId);
    const reader = new CatalogReader(ctx);
    let budget = COMPLETION_READ_BUDGET - recent.length;
    const out: Array<typeof completionValidator.type> = [];
    for (const setId of setIds) {
      if (budget <= 0) break;
      const base = await baseOf(ctx, setId);
      if (!base) continue;
      const held = await baseLines(ctx, ownerId, setId, base._id, sides);
      budget -= held.read;
      if (held.truncated || held.lines.length === 0) continue;
      const distinct = new Set(held.lines.map((l) => l.cardId as string)).size;
      const stored = typeof base.nonVariationCardCount === "number" ? base.nonVariationCardCount : null;
      if (stored !== null && distinct < stored) continue;
      if (budget <= 0) break;
      const checklist = await baseCards(ctx, base._id);
      budget -= checklist.read;
      if (checklist.truncated) continue;
      const done = baseCompletion(
        checklist.cards.map((c) => c._id as string),
        held.lines.map((l) => ({ cardId: l.cardId as string, acquiredOn: l.acquiredOn, _creationTime: l._creationTime })),
      );
      if (!done || done.whenMs < args.sinceMs) continue;
      const set = await reader.setRef(setId);
      if (!set) continue;
      out.push({
        setId,
        setLabel: setLabelOf(set),
        checklistName: null,
        total: checklist.cards.length,
        whenMs: done.whenMs,
        whenDay: done.whenDay,
        lastCardId: done.lastCardId as Id<"cardChecklist">,
        cardIds: done.byArrival.slice(0, CHEER_CARDS) as Array<Id<"cardChecklist">>,
      });
    }
    return out.sort((a, b) => b.whenMs - a.whenMs).slice(0, COMPLETIONS_RETURNED);
  },
});

/**
 * One set's base checklist for its scoreboard: each regular card in order,
 * lit when the caller holds it on the collection side. Read once on mount,
 * one set per call. Null for an id that is not a set, or a set without
 * exactly one Base type. `truncated`: the checklist runs past
 * `MAX_VARIANT_CARDS` cards, or the caller's lines past
 * `MAX_VARIANT_COPIES` (the lit bulbs are then a floor).
 */
export const setBoard = query({
  args: { setId: v.string() },
  returns: v.union(
    v.object({
      cards: v.array(v.object({ cardId: v.id("cardChecklist"), cardNumber: v.string(), owned: v.boolean() })),
      truncated: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const setId = ctx.db.normalizeId("selectorOptions", args.setId);
    const set = setId ? await ctx.db.get(setId) : null;
    if (!setId || !set || set.level !== "setName") return null;
    const base = await baseOf(ctx, setId);
    if (!base) return null;
    const checklist = await baseCards(ctx, base._id);
    const held = await baseLines(ctx, ownerId, setId, base._id, new HomeSides(ctx, ownerId));
    const owned = new Set(held.lines.map((l) => l.cardId as string));
    return {
      cards: checklist.cards.map((c) => ({ cardId: c._id, cardNumber: c.cardNumber, owned: owned.has(c._id) })),
      truncated: checklist.truncated || held.truncated,
    };
  },
});

/**
 * How much of a smart binder's checklist is filed in it, from its stored
 * fits (`collectionBinderFits`), counted as its empty slots are
 * (`smartChecklistCount`). Read once on mount, one binder per call. Null
 * when there is no honest number: not the caller's binder, no rule or a
 * rule that names no checklist (`ruleNamesChecklist`), fits not computed,
 * pending, failed, unsupported or cut short, or more lines or fits than one
 * read holds.
 */
export const smartChecklist = query({
  args: { containerId: v.string() },
  returns: v.union(v.object({ have: v.number(), total: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const id = ctx.db.normalizeId("collectionContainers", args.containerId);
    const binder = id ? await ctx.db.get(id) : null;
    if (!binder || binder.ownerId !== ownerId || binder.kind !== "binder" || !binder.rule) return null;
    if (!ruleNamesChecklist(binder.rule)) return null;
    const state = await ctx.db
      .query("collectionBinderFitsState")
      .withIndex("by_binder", (q) => q.eq("binderId", binder._id))
      .unique();
    if (!state || !state.supported || !state.complete || state.pending || state.failed) return null;
    const lines = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", binder._id))
      .take(MAX_SORTED_LINES + 1);
    if (lines.length > MAX_SORTED_LINES) return null;
    const fits = await ctx.db
      .query("collectionBinderFits")
      .withIndex("by_binder_order", (q) => q.eq("binderId", binder._id))
      .take(MAX_CANDIDATES + 1);
    if (fits.length > MAX_CANDIDATES || fits.length === 0) return null;
    const isParallel = parallelReader(ctx);
    const parallels = new Set<string>();
    for (const variantId of new Set(fits.map((f) => f.variantId))) {
      if (await isParallel(variantId)) parallels.add(variantId);
    }
    const counted = smartChecklistCount(
      fits.map((f) => ({ cardId: f.cardId as string, variantId: f.variantId as string })),
      new Set(lines.map((l) => l.cardId as string)),
      parallels,
    );
    return counted.total > 0 ? counted : null;
  },
});

/**
 * The caller's collection lines (never a box's) filed or moved after
 * `sinceMs`, newest first, at most `NEW_SINCE_LINES`: what "since your last
 * visit" shows per binder. Only filing and moving count (Jason, 2026-11-10):
 * a line's `filedAt`, stamped when cards arrive in its home by a move. An
 * add, an edit, a sale or a trade flag is not news here. Subscribed, so it
 * stays small: one indexed range of at most `NEW_SINCE_LINES` + 1 lines and
 * their homes. `truncated`: more lines moved than are listed.
 */
export const newSince = query({
  args: { sinceMs: v.number() },
  returns: v.object({
    lines: v.array(
      v.object({ homeId: v.id("collectionContainers"), cardId: copyCardIdValidator, filedAt: v.number() }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const rows = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_filedAt", (q) => q.eq("ownerId", ownerId).gt("filedAt", args.sinceMs))
      .order("desc")
      .take(NEW_SINCE_LINES + 1);
    const truncated = rows.length > NEW_SINCE_LINES;
    const kept = await new HomeSides(ctx, ownerId).keep(rows.slice(0, NEW_SINCE_LINES), "collection");
    return {
      lines: kept.flatMap((r) => (r.filedAt === undefined ? [] : [{ homeId: r.homeId, cardId: r.cardId, filedAt: r.filedAt }])),
      truncated,
    };
  },
});

/**
 * The cards that could fit a smart binder: the collector holds a copy in
 * another binder (the fits row's `held` mark, kept by every copy write), the
 * rule takes it in, it is not filed here, and the collector never declined
 * it for this binder. In the fits' order, at most `COULD_FIT_CARDS`. Read
 * once on mount, one binder per call.
 *
 * Bounded: the first `COULD_FIT_SCAN` fits rows, and at most
 * `COULD_FIT_CHECKS` held ones checked (each one indexed read of its lines
 * and one of its decline). `more`: the scan or the checks stopped before
 * the end, or more cards fit than are returned. Null when there is no
 * honest answer: not the caller's smart binder, or its fits not computed,
 * being recomputed, failed or unsupported.
 */
export const couldFit = query({
  args: { containerId: v.string() },
  returns: v.union(v.object({ cardIds: v.array(v.id("cardChecklist")), more: v.boolean() }), v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const id = ctx.db.normalizeId("collectionContainers", args.containerId);
    const binder = id ? await ctx.db.get(id) : null;
    if (!binder || binder.ownerId !== ownerId || binder.kind !== "binder" || !binder.rule) return null;
    const state = await ctx.db
      .query("collectionBinderFitsState")
      .withIndex("by_binder", (q) => q.eq("binderId", binder._id))
      .unique();
    if (!state || !state.supported || state.pending || state.failed) return null;
    const fits = await ctx.db
      .query("collectionBinderFits")
      .withIndex("by_binder_order", (q) => q.eq("binderId", binder._id))
      .take(COULD_FIT_SCAN + 1);
    let more = fits.length > COULD_FIT_SCAN || !state.complete;
    const cardIds: Array<Id<"cardChecklist">> = [];
    let checks = 0;
    for (const fit of fits.slice(0, COULD_FIT_SCAN)) {
      if (fit.held !== true) continue;
      if (cardIds.length >= COULD_FIT_CARDS || checks >= COULD_FIT_CHECKS) {
        more = true;
        break;
      }
      checks += 1;
      const lines = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", fit.cardId))
        .take(LINES_PER_CARD);
      if (lines.some((l) => l.homeId === binder._id && l.quantity > 0)) continue;
      const declined = await ctx.db
        .query("collectionBinderDeclines")
        .withIndex("by_owner_binder_card", (q) =>
          q.eq("ownerId", ownerId).eq("binderId", binder._id).eq("cardId", fit.cardId),
        )
        .first();
      if (declined) continue;
      cardIds.push(fit.cardId);
    }
    return { cardIds, more };
  },
});

/**
 * What is still in intake: the caller's `INTAKE_RUNS` most recently active
 * runs, each counted from its match rows (`intakeRunTally`), and the runs
 * the hopper lists (`intakeRunShows`). Read once on mount.
 *
 * Bounded: at most `INTAKE_RUN_ROWS` match rows per run and
 * `INTAKE_READ_BUDGET` across them, one home read per run. `truncated`: a
 * run held more rows than were read, or the budget ran out, so the counts
 * are a floor. Photos still being processed have no match row yet and are
 * not counted.
 */
export const intake = query({
  args: {},
  returns: v.object({
    needsYou: v.number(),
    unidentified: v.number(),
    runs: v.array(
      v.object({
        runId: v.id("intakeRuns"),
        homeName: v.string(),
        /** Where the run's cards are going, so the hopper links to the screen that finishes it. */
        side: sideValidator,
        scans: v.number(),
        done: v.number(),
      }),
    ),
    guesses: v.array(v.object({ id: v.id("intakeMatches"), cardId: v.id("cardChecklist") })),
    unknown: v.array(v.id("intakeMatches")),
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    const userId = await requireSignedIn(ctx);
    const now = Date.now();
    const runs = await ctx.db
      .query("intakeRuns")
      .withIndex("by_user_and_activity", (q) => q.eq("userId", userId))
      .order("desc")
      .take(INTAKE_RUNS);
    const out = {
      needsYou: 0,
      unidentified: 0,
      runs: [] as Array<{ runId: Id<"intakeRuns">; homeName: string; side: Side; scans: number; done: number }>,
      guesses: [] as Array<{ id: Id<"intakeMatches">; cardId: Id<"cardChecklist"> }>,
      unknown: [] as Array<Id<"intakeMatches">>,
      truncated: false,
    };
    let budget = INTAKE_READ_BUDGET;
    for (const run of runs) {
      if (budget <= 0) {
        out.truncated = true;
        break;
      }
      const home = await ctx.db.get(run.homeId);
      if (!home) continue;
      const cap = Math.min(INTAKE_RUN_ROWS, budget);
      const rows = await ctx.db
        .query("intakeMatches")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(cap + 1);
      budget -= rows.length;
      if (rows.length > cap) out.truncated = true;
      const tally = intakeRunTally(rows.slice(0, cap));
      if (!intakeRunShows(tally, run.lastActivityAt, now)) continue;
      out.needsYou += tally.needsYou;
      out.unidentified += tally.unidentified;
      out.runs.push({ runId: run._id, homeName: home.name, side: sideOfContainer(home), scans: tally.scans, done: tally.done });
      for (const g of tally.guesses) {
        if (out.guesses.length < INTAKE_PREVIEW_GUESSES) {
          out.guesses.push({ id: g.id as Id<"intakeMatches">, cardId: g.cardId as Id<"cardChecklist"> });
        }
      }
      for (const u of tally.unknown) {
        if (out.unknown.length < INTAKE_PREVIEW_UNKNOWN) out.unknown.push(u as Id<"intakeMatches">);
      }
    }
    return out;
  },
});

const saleLineValidator = v.object({
  /** Absent: NB could not tie the line to a card (never a guess). */
  cardId: v.optional(v.id("cardChecklist")),
  quantity: v.number(),
  problem: v.optional(saleItemProblemValidator),
  /** `oversold` only: how many sold that NB held no copy for. */
  shortBy: v.optional(v.number()),
});

/**
 * Whether the caller sells, and the newest of their orders still to ship.
 * Read once on mount.
 *
 * `dealer` (the sales section shows): a listing platform connected (any of
 * `LISTING_PLATFORMS`, which one never matters) or any order stored. Still
 * to ship: `listingSales.awaitingShipment`, the platform's own status word,
 * since NB keeps no shipped state of its own. Bounded: the newest
 * `SALES_SCAN` orders, at most `SALES_SHOWN` returned, newest first, each
 * with at most `SALE_LINES` lines. `more`: more orders to ship than are
 * returned, or the scan stopped before the oldest order.
 */
export const sales = query({
  args: {},
  returns: v.object({
    dealer: v.boolean(),
    orders: v.array(
      v.object({
        id: v.id("marketplaceSales"),
        platform: listingPlatformValidator,
        orderNo: v.string(),
        orderDate: v.number(),
        status: v.string(),
        lines: v.array(saleLineValidator),
        cardCount: v.number(),
        problemPastCut: v.boolean(),
      }),
    ),
    more: v.boolean(),
  }),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const rows = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_date", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(SALES_SCAN + 1);
    const connected: boolean[] = [];
    if (rows.length === 0) {
      for (const platform of LISTING_PLATFORMS) {
        connected.push((await listingCredentialOf(ctx, ownerId, platform)).hasCredentials);
      }
    }
    if (!isDealer(connected, rows.length > 0)) return { dealer: false, orders: [], more: false };
    const toShip = rows.slice(0, SALES_SCAN).filter((row) => awaitingShipment(row.platform, row.status));
    return {
      dealer: true,
      orders: toShip.slice(0, SALES_SHOWN).map((row) => ({
        id: row._id,
        platform: row.platform,
        orderNo: row.orderNo,
        orderDate: row.orderDate,
        status: row.status,
        ...saleLinesOf(row.items),
      })),
      more: toShip.length > SALES_SHOWN || rows.length > SALES_SCAN,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Mutation
// ───────────────────────────────────────────────────────────────────────────

/**
 * The dashboard opened: answers where this visit's "new" starts (null on
 * the first visit), read BEFORE the stamp moves, then stamps the open
 * (`nextVisit`). Creates the profile row when there is none yet.
 */
export const markVisit = mutation({
  args: {},
  returns: v.object({ sinceMs: v.union(v.number(), v.null()) }),
  handler: async (ctx) => {
    const userId = await requireSignedIn(ctx);
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const next = nextVisit(profile?.dashboardVisit, Date.now());
    if (next.write) {
      if (profile) await ctx.db.patch(profile._id, { dashboardVisit: next.visit });
      else await ctx.db.insert("userProfiles", { userId, dashboardVisit: next.visit });
    }
    return { sinceMs: next.since };
  },
});
