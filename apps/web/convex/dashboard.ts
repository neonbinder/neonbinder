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
 *   collection lines filed since the last visit (an add or a move into a
 *   binder; never an edit).
 * - `freshPulls` (subscribed, at most `FRESH_PULL_LINES` + 1 stamped lines
 *   and `LEGACY_SCAN` + 1 unstamped ones): the collection lines whose cards
 *   were added new since a moment (Fresh Pulls; an add into a binder, never
 *   a move). A line from before the stamps counts by its creation time.
 * - `newListings` (subscribed, the same bounds with `NEW_LISTING_LINES`):
 *   the box lines that landed in Inventory since a moment (an add into a
 *   box, a raise, a Sell from a binder; never a box-to-box move), with NB's
 *   price. Inventory only: nothing about a marketplace or a sync.
 * - `syncAlerts` (read once, `SYNC_PENDING_SCAN` queued rows and
 *   `SYNC_RECORD_SCAN` sync records per platform): the cards waiting for the
 *   next sync, and each set whose latest sync failed or held cards back,
 *   from NB's own records of its syncs (`listingOutbox`,
 *   `marketplaceListingSyncs`).
 * - `markVisit` (mutation): reads the last visit, then stamps this one (and,
 *   once, `dashboardStampsFrom`: the line between unstamped and stamped rows).
 * - `couldFit` (read once, one smart binder per call): the cards the
 *   collector holds in another binder that the binder's rule takes in, at
 *   most `COULD_FIT_CARDS`, from its stored fits' `held` mark.
 * - `intake` (read once): the collector's recent runs with scans still open,
 *   counted from their match rows, each with the side its home is on (a
 *   binder's run finishes on Collection, a box's on Inventory), and how many
 *   runs were sorted this week and all-time.
 * - `newSets` (read once, a few entries): the catalog's newest checklist
 *   uploads, grouped by set, the same for everyone (New on NeonBinder).
 * - `sales` (read once): whether the account sells (the sales section shows), and
 *   its newest orders still to ship, at most `SALES_SHOWN`.
 *
 * NB data only, except `sales` (and `syncAlerts`, which reads NB's records of
 * its own syncs, never a marketplace): an order's status is the platform's own word
 * (NB keeps no shipped state), read through `listingSales.awaitingShipment`.
 * The sales gate never names a platform, and never reads a login: it shows
 * for an account with at least one order stored.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireSignedIn } from "./auth";
import { MAX_CANDIDATES, parallelReader } from "./binderRules";
import { HomeSides, MAX_VARIANT_COPIES, copyCardIdValidator, sideOfContainer, sideValidator, type Side } from "./collection";
import { MAX_DRILL_ITEMS, MAX_VARIANT_CARDS, hiddenAsEmpty } from "./collectionCatalog";
import { CatalogReader, setRefValidator, variantRefValidator, type SetRef, type VariantRef } from "./lib/catalogView";
import { awaitingShipment } from "./listingSales";
import { LISTING_PLATFORMS } from "./listingOutbox";
import { ListingLabels, brandedSetLabel } from "./lib/listingLabels";
import { listingPlatformValidator, listingProblemReasonValidator, saleItemProblemValidator } from "./schema";
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
/** A run finished within this long counts as sorted this week. */
export const INTAKE_RECENT_MS = 7 * 86_400_000;
/** Match rows read from one run (`intakeRuns.INTAKE_SETTLE_SCAN`). */
export const INTAKE_RUN_ROWS = 1000;
/** Match rows `intake` reads across every run. */
export const INTAKE_READ_BUDGET = 5000;
/** Best guesses one run shows as thumbnails. */
export const INTAKE_PREVIEW_GUESSES = 3;
/** Best guesses `intake` returns across every run (each is a card to hydrate). */
export const INTAKE_PREVIEW_CARDS = 9;
/** Orders `sales` looks through, newest first. */
export const SALES_SCAN = 100;
/** Orders still to ship `sales` returns, newest first. */
export const SALES_SHOWN = 10;
/** Lines of one order returned (the rest are counted). */
export const SALE_LINES = 12;
/** Lines `freshPulls` returns, newest first. */
export const FRESH_PULL_LINES = 100;
/**
 * Lines with no stamp the legacy read looks through (`freshPulls`,
 * `newListings`): the lines written before the collector's first dashboard
 * open under the stamps (`userProfiles.dashboardStampsFrom`), newest first.
 * Bounded twice: by this, and by the window, which passes that moment two
 * weeks after it, so the read then finds nothing at all.
 */
export const LEGACY_SCAN = 200;
/**
 * A line with no stamp counts by its `_creationTime` only when it was filed
 * where it is in the write that made it. Production never stamped `filedAt`
 * before `addedAt` and `listedAt` (they ship together), so there a legacy line
 * has no `filedAt` at all. A development deployment ran `filedAt` alone for a
 * while, until `FILED_ONLY_ERA_END`: a line written then counts when its
 * `filedAt` is within this of `_creationTime` (the same add). A line filed
 * later was moved in: never a pull, never a listing.
 */
export const STAMP_SLACK_MS = 5000;
/**
 * The end of the stretch when a development deployment stamped `filedAt` but
 * not `addedAt` (NEO-464 review rounds 1 and 2, 2026-11-10). Lines written
 * since never take the slack above: one of them with a `filedAt` and no
 * stamp was moved in (a Sell or a Take off sale drops the other side's stamp).
 */
export const FILED_ONLY_ERA_END = Date.UTC(2026, 10, 10, 22, 30);
/** Lines `newListings` returns, newest first. */
export const NEW_LISTING_LINES = 60;
/** Cards waiting to sync `syncAlerts` counts on one platform (more reads "more"). */
export const SYNC_PENDING_SCAN = 100;
/** Sets' last results `syncAlerts` looks through on one platform, most recent run first. */
export const SYNC_RECORD_SCAN = 50;
/** Sets with an unresolved problem `syncAlerts` returns across platforms. */
export const SYNC_ALERTS_SHOWN = 6;
/**
 * Held-back cards named for one set (the rest are counted, and open on Sync
 * status). Every named card is a way to its fix on the dashboard (Jason,
 * 2026-11-11: held-back cards are "probably more important than other things
 * within sync"), so this is generous; the cap keeps the card reads that
 * follow a few hundred at most (`SYNC_ALERTS_SHOWN` sets of it).
 */
export const SYNC_CARDS_NAMED = 30;
/** New on NeonBinder: how many entries (a set, or one variant of it) it shows. */
export const NEW_SETS_SHOWN = 6;
/** How many variants' worth of newest cards it steps back through to find them. */
export const NEW_SETS_HOPS = 100;
/**
 * One upload of a variant's checklist: its cards written within this of its
 * newest one. The walk steps back past them in one go, and no further, so a
 * card added to an old checklist never carries the walk back to that
 * checklist's first upload.
 */
export const VARIANT_UPLOAD_MS = 86_400_000;
/** One load of a set: its variants uploaded within this of the set's newest upload. */
export const SET_LOAD_MS = 7 * 86_400_000;

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
 * NEO-464 — a line with no dashboard stamp, written before the stamps
 * (`legacyBefore`, the collector's first dashboard open under them): when its
 * cards landed where they are, or null when that is not known. Known only
 * when the line was filed in the write that made it (`filedAt` absent, or
 * within `STAMP_SLACK_MS` of `_creationTime` before `FILED_ONLY_ERA_END`):
 * then its `_creationTime`. A
 * line moved in later (Take off sale, Sell, a move between binders) is never
 * a pull or a listing by this rule. Null with no `legacyBefore` (nothing is
 * read as legacy until the dashboard has opened), and for a line written at
 * or after it (the stamps were live: a missing one means it was no add).
 */
export function legacyStampOf(
  row: { _creationTime: number; filedAt?: number },
  legacyBefore: number | undefined,
): number | null {
  if (legacyBefore === undefined || row._creationTime >= legacyBefore) return null;
  if (row.filedAt === undefined) return row._creationTime;
  const sameWrite = Math.abs(row.filedAt - row._creationTime) <= STAMP_SLACK_MS;
  return row._creationTime < FILED_ONLY_ERA_END && sameWrite ? row._creationTime : null;
}

/**
 * Stamped lines and legacy ones, merged newest first, at most `cap`.
 * `truncated`: either read held more than it gave, or the merge dropped some.
 */
export function mergeStamped<T extends { at: number }>(
  stamped: readonly T[],
  legacy: readonly T[],
  cap: number,
  readTruncated: boolean,
): { lines: T[]; truncated: boolean } {
  const all = [...stamped, ...legacy].sort((a, b) => b.at - a.at);
  return { lines: all.slice(0, cap), truncated: readTruncated || all.length > cap };
}

/**
 * NEO-464 — a set's last listing result as the dashboard's sync status reads
 * it: still failing (`failed`) when its latest run ended in an error, so a
 * later clean run hides an earlier failure (it self-corrected) and a later
 * failure shows whatever came before. A `running` record whose lease ran out
 * is a run that died: its last result stands (an error when it holds one). A
 * run going now is not a failure. `heldBack`: the cards the last run held
 * back (each one's latest outcome, since every run rewrites them).
 */
export function syncOutcome(
  record: Pick<Doc<"marketplaceListingSyncs">, "status" | "leaseExpiresAt" | "lastError" | "problems" | "problemsTotal">,
  now: number,
): { failed: boolean; heldBack: number } {
  const died = record.status === "running" && (record.leaseExpiresAt ?? 0) <= now;
  const failed = record.status === "error" || (died && record.lastError !== undefined);
  return { failed, heldBack: record.problemsTotal ?? record.problems.length };
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
  const out: IntakeRunTally = { scans: rows.length, done: 0, needsYou: 0, unidentified: 0, guesses: [] };
  for (const row of ordered) {
    if (row.savedAt !== undefined || row.setAside === true) {
      out.done += 1;
    } else if (row.cardId) {
      out.needsYou += 1;
      if (out.guesses.length < INTAKE_PREVIEW_GUESSES) out.guesses.push({ id: row._id, cardId: row.cardId });
    } else {
      out.unidentified += 1;
    }
  }
  return out;
}

/** A run with scans and none of them open: sorted. An empty run is not. */
export function intakeRunSorted(tally: Pick<IntakeRunTally, "scans" | "done">): boolean {
  return tally.scans > 0 && tally.done >= tally.scans;
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

/** One upload the New on NeonBinder walk found: its variant and set, whether it is the set's Base, when its newest card landed. */
export interface UploadHop {
  variantId: string;
  setId: string;
  isBase: boolean;
  at: number;
}

/** One New on NeonBinder entry: a whole set's load (opens on its Base), or one variant. */
export type LoadEntry<H extends UploadHop> =
  | { kind: "set"; opens: H; at: number; closesAt: number }
  | { kind: "variant"; opens: H; at: number; closesAt: number };

/**
 * New on NeonBinder's rule (Jason, 2026-11-10): the variants uploaded lately
 * (`hops`, newest first, each variant once), grouped by set into loads: a
 * variant joins its set's newest load when it landed within `SET_LOAD_MS` of
 * that load's newest upload, else starts an older load of the set.
 *
 * - A load with the Base in it is a set load: one entry, the set, opening
 *   on its Base, whatever else came with it.
 * - Without the Base, each variant is its own entry (one alone is "a newly
 *   discovered parallel"; several without a Base are each named, a default
 *   Jason can change).
 *
 * Newest first, by each entry's newest upload, and each checklist once: an
 * older load that would open the same checklist again is dropped (a late card
 * on an old Base makes the set news again, once). `closesAt`: the walk must
 * have stepped below this before nothing more can join the entry's load
 * (`newSetsSettled`).
 */
export function checklistLoads<H extends UploadHop>(hops: readonly H[]): Array<LoadEntry<H>> {
  const loads: Array<{ setId: string; anchor: number; members: H[] }> = [];
  const newestOf = new Map<string, (typeof loads)[number]>();
  for (const hop of hops) {
    const open = newestOf.get(hop.setId);
    if (open && open.anchor - hop.at <= SET_LOAD_MS) {
      if (!open.members.some((m) => m.variantId === hop.variantId)) open.members.push(hop);
      continue;
    }
    const load = { setId: hop.setId, anchor: hop.at, members: [hop] };
    loads.push(load);
    newestOf.set(hop.setId, load);
  }
  const out: Array<LoadEntry<H>> = [];
  for (const load of loads) {
    const closesAt = load.anchor - SET_LOAD_MS;
    const base = load.members.find((m) => m.isBase);
    if (base) out.push({ kind: "set", opens: base, at: load.anchor, closesAt });
    else for (const m of load.members) out.push({ kind: "variant", opens: m, at: m.at, closesAt });
  }
  const opened = new Set<string>();
  return out
    .sort((a, b) => b.at - a.at)
    .filter((e) => {
      if (opened.has(e.opens.variantId)) return false;
      opened.add(e.opens.variantId);
      return true;
    });
}

/**
 * Can the walk stop? Once it holds `shown` entries and has stepped below
 * (`before`) every one of the top `shown` entries' loads, no older upload can
 * join one of them (folding variants into a set) or outrank one.
 */
export function newSetsSettled<H extends UploadHop>(entries: ReadonlyArray<LoadEntry<H>>, before: number, shown: number): boolean {
  if (entries.length < shown) return false;
  return entries.slice(0, shown).every((e) => before <= e.closesAt);
}

// ───────────────────────────────────────────────────────────────────────────
// Reads shared by the queries
// ───────────────────────────────────────────────────────────────────────────

/**
 * The set's Base type (its title is its kind, `variantRole`). Exactly one
 * per set; anything else (none, or a set breaking that rule) is null: never
 * a guess at which one is the base.
 */
async function baseOf(ctx: Ctx, setId: Id<"selectorOptions">): Promise<{ base: OptionRow | null; read: number }> {
  const types = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) => q.eq("level", "variantType").eq("parentId", setId))
    .take(MAX_DRILL_ITEMS);
  const bases = types.filter((t) => variantTypeKind(t) === "base");
  return { base: bases.length === 1 ? bases[0] : null, read: types.length };
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
 * checklist is read; each checklist is read at most once, and only while
 * the budget still holds a whole variant's cards (`MAX_VARIANT_CARDS`). The
 * whole call stops at `COMPLETION_READ_BUDGET` documents, the type lists
 * read to find each Base counted.
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
      const found = await baseOf(ctx, setId);
      budget -= found.read;
      const base = found.base;
      if (!base) continue;
      const held = await baseLines(ctx, ownerId, setId, base._id, sides);
      budget -= held.read;
      if (held.truncated || held.lines.length === 0) continue;
      const distinct = new Set(held.lines.map((l) => l.cardId as string)).size;
      const stored = typeof base.nonVariationCardCount === "number" ? base.nonVariationCardCount : null;
      if (stored !== null && distinct < stored) continue;
      // The checklist read can take a whole variant's cards: only start it when
      // the budget still holds that many.
      if (budget < MAX_VARIANT_CARDS + 1) continue;
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
        setLabel: brandedSetLabel(set),
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
    const { base } = await baseOf(ctx, setId);
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
 * The caller's collection lines (never a box's) filed after `sinceMs`, newest
 * first, at most `NEW_SINCE_LINES`: what "since your last visit" shows per
 * binder, Main included. A line's `filedAt` is stamped whenever cards arrive
 * in its home, by an add or a move (Jason, 2026-11-10: "adding cards to a
 * binder in any way is filed"). An edit, a sale, a trade flag or a pocket
 * shuffle in the same binder is not news here. Subscribed, so it
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

/** NEO-464 — the caller's first dashboard open under the stamps, or undefined (`userProfiles.dashboardStampsFrom`). */
async function stampsFromOf(ctx: Ctx, userId: string): Promise<number | undefined> {
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return profile?.dashboardStampsFrom;
}

/**
 * Fresh Pulls: the caller's collection lines (never a box's) whose cards were
 * added new after `sinceMs`, newest first, at most `FRESH_PULL_LINES`. Reads
 * `addedAt`, which only an add into a binder stamps (Jason, 2026-11-10: "only
 * cards new to the collection, never moves"): a move, a split, a container
 * emptied or an undo's put-back never makes a card fresh, and a move into a
 * box drops it.
 *
 * Lines written before the stamps (no `addedAt`) count too, by
 * `_creationTime` (`legacyStampOf`), so cards added before this shipped are
 * not lost, in production as well, with no backfill: one more bounded range
 * of the lines with no `addedAt` written inside the window and before the
 * caller's first dashboard open under the stamps, at most `LEGACY_SCAN`.
 *
 * Subscribed, so it stays small: two indexed ranges, the profile and the
 * lines' homes. `truncated`: more lines than are listed.
 */
export const freshPulls = query({
  args: { sinceMs: v.number() },
  returns: v.object({
    lines: v.array(
      v.object({ homeId: v.id("collectionContainers"), cardId: copyCardIdValidator, addedAt: v.number() }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const sides = new HomeSides(ctx, ownerId);
    const rows = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_addedAt", (q) => q.eq("ownerId", ownerId).gt("addedAt", args.sinceMs))
      .order("desc")
      .take(FRESH_PULL_LINES + 1);
    const kept = await sides.keep(rows.slice(0, FRESH_PULL_LINES), "collection");
    const stamped = kept.flatMap((r) => (r.addedAt === undefined ? [] : [{ row: r, at: r.addedAt }]));
    const legacy = await legacyLines(ctx, ownerId, "by_owner_and_addedAt", "addedAt", args.sinceMs, sides, "collection");
    const merged = mergeStamped(stamped, legacy.lines, FRESH_PULL_LINES, rows.length > FRESH_PULL_LINES || legacy.truncated);
    return {
      lines: merged.lines.map(({ row, at }) => ({ homeId: row.homeId, cardId: row.cardId, addedAt: at })),
      truncated: merged.truncated,
    };
  },
});

/**
 * The legacy half of `freshPulls` and `newListings`: the caller's lines with
 * no `field` stamp, written after `sinceMs` and before their first dashboard
 * open under the stamps, newest first, that `legacyStampOf` dates, on
 * `side`. At most `LEGACY_SCAN` read. Nothing before that first open.
 */
async function legacyLines(
  ctx: Ctx,
  ownerId: string,
  index: "by_owner_and_addedAt" | "by_owner_and_listedAt",
  field: "addedAt" | "listedAt",
  sinceMs: number,
  sides: HomeSides,
  side: Side,
): Promise<{ lines: Array<{ row: CopyRow; at: number }>; truncated: boolean }> {
  const before = await stampsFromOf(ctx, ownerId);
  if (before === undefined || before <= sinceMs) return { lines: [], truncated: false };
  const rows = await ctx.db
    .query("collectionCopies")
    .withIndex(index, (q) =>
      q.eq("ownerId", ownerId).eq(field, undefined).gt("_creationTime", sinceMs).lt("_creationTime", before),
    )
    .order("desc")
    .take(LEGACY_SCAN + 1);
  const lines: Array<{ row: CopyRow; at: number }> = [];
  for (const row of rows.slice(0, LEGACY_SCAN)) {
    const at = legacyStampOf(row, before);
    if (at !== null && (await sides.is(row.homeId, side))) lines.push({ row, at });
  }
  return { lines, truncated: rows.length > LEGACY_SCAN };
}

/**
 * New Listings: the caller's box lines (Unsorted included) whose cards landed
 * in Inventory after `sinceMs`, newest first, at most `NEW_LISTING_LINES`
 * (Jason, 2026-11-10: "Listings come from our Inventory ... don't worry
 * about if it has sync'd yet or not"). Reads `listedAt` (an add into a box, a
 * box raise, a Sell from a binder; a move between boxes carries it), and,
 * like `freshPulls`, a line written before the stamps by `_creationTime`.
 * NB data only: no marketplace's listing state is read.
 *
 * Each line with its quantity and NB's price for one copy: the line's own
 * floor (`minPriceCents`), else the owner's common price for its variant
 * (`variantCommonPrices`, read once per variant), else null (none set).
 * Subscribed: two indexed ranges, the profile, the lines' homes and at most
 * one common price per variant. `truncated`: more lines than are listed.
 */
export const newListings = query({
  args: { sinceMs: v.number() },
  returns: v.object({
    lines: v.array(
      v.object({
        id: v.id("collectionCopies"),
        homeId: v.id("collectionContainers"),
        cardId: copyCardIdValidator,
        listedAt: v.number(),
        quantity: v.number(),
        priceCents: v.union(v.number(), v.null()),
      }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const sides = new HomeSides(ctx, ownerId);
    const rows = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_listedAt", (q) => q.eq("ownerId", ownerId).gt("listedAt", args.sinceMs))
      .order("desc")
      .take(NEW_LISTING_LINES + 1);
    const kept = await sides.keep(rows.slice(0, NEW_LISTING_LINES), "inventory");
    const stamped = kept.flatMap((r) => (r.listedAt === undefined ? [] : [{ row: r, at: r.listedAt }]));
    const legacy = await legacyLines(ctx, ownerId, "by_owner_and_listedAt", "listedAt", args.sinceMs, sides, "inventory");
    const merged = mergeStamped(stamped, legacy.lines, NEW_LISTING_LINES, rows.length > NEW_LISTING_LINES || legacy.truncated);
    const common = new Map<string, number | null>();
    const lines = [];
    for (const { row, at } of merged.lines) {
      let priceCents: number | null = row.minPriceCents ?? null;
      if (priceCents === null && row.variantId !== undefined) {
        const key = row.variantId as string;
        if (!common.has(key)) {
          const price = await ctx.db
            .query("variantCommonPrices")
            .withIndex("by_owner_and_variant", (q) => q.eq("ownerId", ownerId).eq("variantId", row.variantId!))
            .unique();
          common.set(key, price?.priceCents ?? null);
        }
        priceCents = common.get(key) ?? null;
      }
      lines.push({ id: row._id, homeId: row.homeId, cardId: row.cardId, listedAt: at, quantity: row.quantity, priceCents });
    }
    return { lines, truncated: merged.truncated };
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
 * The hopper: the caller's `INTAKE_RUNS` most recently active runs, each
 * counted from its match rows (`intakeRunTally`). Every run with a scan still
 * open is returned, with its counts and a few best guesses; a sorted run is
 * only counted (`intakeRunSorted`): this week when its last activity is
 * within `INTAKE_RECENT_MS`, and all-time. Read once on mount.
 *
 * Bounded: at most `INTAKE_RUN_ROWS` match rows per run and
 * `INTAKE_READ_BUDGET` across them, one home read per run. `truncated`: a
 * run held more rows than were read, or the budget ran out, so the counts
 * are a floor. All-time counts only the runs read: `sortedAllTimeMore` says
 * there may be more (older runs past `INTAKE_RUNS`, a read cut short, or a
 * run skipped because its home is gone or not the caller's).
 * Photos still being processed have no match row yet and are not counted.
 */
export const intake = query({
  args: {},
  returns: v.object({
    needsYou: v.number(),
    unidentified: v.number(),
    /** Runs with a scan still open, newest activity first. */
    runs: v.array(
      v.object({
        runId: v.id("intakeRuns"),
        homeName: v.string(),
        /** Where the run's cards are going, so the hopper links to the screen that finishes it. */
        side: sideValidator,
        /** Open scans with a best guess, waiting on a yes. */
        needsYou: v.number(),
        /** Open scans nothing identified yet. */
        unidentified: v.number(),
        /** The run's last scan or decision: two runs into one home read apart by it. */
        lastActivityAt: v.number(),
        /** Its first best guesses, for thumbnails (`INTAKE_PREVIEW_GUESSES`, `INTAKE_PREVIEW_CARDS` across runs). */
        guesses: v.array(v.id("cardChecklist")),
      }),
    ),
    /** Sorted runs whose last activity is within `INTAKE_RECENT_MS`. */
    sortedThisWeek: v.number(),
    /** Sorted runs among those read. */
    sortedAllTime: v.number(),
    /** `sortedAllTime` is a floor: more runs exist than were read, a read was cut short, or a run was skipped. */
    sortedAllTimeMore: v.boolean(),
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    const userId = await requireSignedIn(ctx);
    const now = Date.now();
    const read = await ctx.db
      .query("intakeRuns")
      .withIndex("by_user_and_activity", (q) => q.eq("userId", userId))
      .order("desc")
      .take(INTAKE_RUNS + 1);
    const runs = read.slice(0, INTAKE_RUNS);
    const out = {
      needsYou: 0,
      unidentified: 0,
      runs: [] as Array<{
        runId: Id<"intakeRuns">;
        homeName: string;
        side: Side;
        needsYou: number;
        unidentified: number;
        lastActivityAt: number;
        guesses: Array<Id<"cardChecklist">>;
      }>,
      sortedThisWeek: 0,
      sortedAllTime: 0,
      sortedAllTimeMore: read.length > INTAKE_RUNS,
      truncated: false,
    };
    let budget = INTAKE_READ_BUDGET;
    let previews = INTAKE_PREVIEW_CARDS;
    for (const run of runs) {
      if (budget <= 0) {
        out.truncated = true;
        break;
      }
      const home = await ctx.db.get(run.homeId);
      // A run names its home by id; only the caller's own home's name is ever returned. A run
      // skipped here is not counted at all, so all-time says it may be more.
      if (!home || home.ownerId !== userId) {
        out.sortedAllTimeMore = true;
        continue;
      }
      const cap = Math.min(INTAKE_RUN_ROWS, budget);
      const rows = await ctx.db
        .query("intakeMatches")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .take(cap + 1);
      budget -= rows.length;
      if (rows.length > cap) out.truncated = true;
      const tally = intakeRunTally(rows.slice(0, cap));
      if (tally.scans === 0) continue;
      if (intakeRunSorted(tally)) {
        out.sortedAllTime += 1;
        if (now - run.lastActivityAt <= INTAKE_RECENT_MS) out.sortedThisWeek += 1;
        continue;
      }
      out.needsYou += tally.needsYou;
      out.unidentified += tally.unidentified;
      const guesses = tally.guesses.slice(0, previews).map((g) => g.cardId as Id<"cardChecklist">);
      previews -= guesses.length;
      out.runs.push({
        runId: run._id,
        homeName: home.name,
        side: sideOfContainer(home),
        needsYou: tally.needsYou,
        unidentified: tally.unidentified,
        lastActivityAt: run.lastActivityAt,
        guesses,
      });
    }
    if (out.truncated) out.sortedAllTimeMore = true;
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
 * `dealer` (the sales section shows): at least one order stored, on any
 * platform. A sign-in or a connected platform alone never shows it (Jason,
 * 2026-11-10: each widget shows for what the collector has, "no criteria
 * based simply on whether or not you have a login configured"). Still
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
    if (rows.length === 0) return { dealer: false, orders: [], more: false };
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

/**
 * NEO-464 — the dashboard's sync status, at the top (Jason, 2026-11-10: "any
 * sync errors that have not self corrected, ie only show errors that have not
 * had a successful sync of that card/set later. Also show pending syncs there
 * if there are any pending."). Read once on mount. From NB's own records
 * only: the cards queued for the next sync (`listingOutbox`) and each set's
 * last result (`marketplaceListingSyncs`, a summary every run rewrites, so it
 * IS the latest outcome; `syncOutcome` is the rule). A platform is named
 * only as where the cards go; nothing here keys on which one it is.
 *
 * - `pending`: per platform with any, the cards waiting (at most
 *   `SYNC_PENDING_SCAN` counted; `more` past that).
 * - `sets`: the sets whose last run failed or held cards back, those holding
 *   cards back first, then most recent run first, at most
 *   `SYNC_ALERTS_SHOWN`, each naming up to
 *   `SYNC_CARDS_NAMED` held-back cards (the rest counted). `more`: another
 *   set has one too, or the scan stopped short.
 *
 * Bounded: per platform one range of at most `SYNC_PENDING_SCAN` + 1 queued
 * rows and one of `SYNC_RECORD_SCAN` records, then one label per set shown.
 */
export const syncAlerts = query({
  args: {},
  returns: v.object({
    pending: v.array(v.object({ platform: listingPlatformValidator, cards: v.number(), more: v.boolean() })),
    sets: v.array(
      v.object({
        platform: listingPlatformValidator,
        variantId: v.id("selectorOptions"),
        setLabel: v.string(),
        failed: v.boolean(),
        /** NB's own sentence for the failure (the record's `lastError`), when the run failed. */
        message: v.optional(v.string()),
        lastRunAt: v.optional(v.number()),
        heldBack: v.number(),
        cards: v.array(
          v.object({
            cardId: v.id("cardChecklist"),
            reason: listingProblemReasonValidator,
            detail: v.optional(v.string()),
          }),
        ),
      }),
    ),
    more: v.boolean(),
  }),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const now = Date.now();
    const pending = [];
    const found: Array<{ record: Doc<"marketplaceListingSyncs">; failed: boolean; heldBack: number }> = [];
    let more = false;
    for (const platform of LISTING_PLATFORMS) {
      const queued = await ctx.db
        .query("listingOutbox")
        .withIndex("by_owner_platform_changed", (q) => q.eq("ownerId", ownerId).eq("platform", platform))
        .take(SYNC_PENDING_SCAN + 1);
      if (queued.length > 0) {
        pending.push({ platform, cards: Math.min(queued.length, SYNC_PENDING_SCAN), more: queued.length > SYNC_PENDING_SCAN });
      }
      const records = await ctx.db
        .query("marketplaceListingSyncs")
        .withIndex("by_owner_platform_run", (q) => q.eq("ownerId", ownerId).eq("platform", platform))
        .order("desc")
        .take(SYNC_RECORD_SCAN + 1);
      if (records.length > SYNC_RECORD_SCAN) more = true;
      for (const record of records.slice(0, SYNC_RECORD_SCAN)) {
        const outcome = syncOutcome(record, now);
        if (outcome.failed || outcome.heldBack > 0) found.push({ record, ...outcome });
      }
    }
    // Sets holding cards back come first (each card is something the collector can fix), then the newest run.
    found.sort(
      (a, b) =>
        Number(b.heldBack > 0) - Number(a.heldBack > 0) || (b.record.lastRunAt ?? 0) - (a.record.lastRunAt ?? 0),
    );
    if (found.length > SYNC_ALERTS_SHOWN) more = true;
    // The set named with its brand, as the cards' listing titles under it name it (NEO-464).
    const labels = new ListingLabels(ctx, { brand: true });
    const sets = [];
    for (const { record, failed, heldBack } of found.slice(0, SYNC_ALERTS_SHOWN)) {
      sets.push({
        platform: record.platform,
        variantId: record.variantId,
        setLabel: await labels.setLabel(record.variantId),
        failed,
        ...(failed && record.lastError !== undefined ? { message: record.lastError } : {}),
        ...(record.lastRunAt !== undefined ? { lastRunAt: record.lastRunAt } : {}),
        heldBack,
        cards: record.problems
          .flatMap((p) =>
            p.cardId === undefined
              ? []
              : [{ cardId: p.cardId, reason: p.reason, ...(p.detail !== undefined ? { detail: p.detail } : {}) }],
          )
          .slice(0, SYNC_CARDS_NAMED),
      });
    }
    return { pending, sets, more };
  },
});

/**
 * New on NeonBinder: the checklists uploaded to the catalog most recently,
 * grouped by set (`checklistLoads`), newest first, at most `NEW_SETS_SHOWN`
 * entries. Catalog news, the same for every collector (Jason, 2026-11-10:
 * "collectors wouldn't be able to get to a set that doesn't have a
 * checklist"). Each entry names the checklist it opens (`opens`): a whole
 * set's load opens on its Base, a lone variant on itself. With its card count
 * (the set's, or the variant's) and a cover card: the first card of what it
 * opens.
 *
 * Read from the cards, not the set rows: most set rows are made long before
 * any card (a marketplace's list of sets). The newest card names a variant;
 * the walk then steps back past that variant's upload (its cards within
 * `VARIANT_UPLOAD_MS` of that card, found on `by_selector_option`, whose last
 * key is `_creationTime`) and asks again, never further: a late card on an
 * old checklist never carries the walk back to that checklist's first upload.
 * A variant in a set known to hold no cards is passed over.
 *
 * Bounded: at most `NEW_SETS_HOPS` steps of two cards and a variant's chain,
 * stopping early once the top entries are settled (`newSetsSettled`), then
 * one card for each entry's cover. The dashboard reads it once on load, not
 * subscribed: every card added anywhere would re-run it.
 */
export const newSets = query({
  args: {},
  returns: v.array(
    v.object({
      set: setRefValidator,
      /** The checklist the entry opens: the set's Base for a whole set's load, else the variant. */
      opens: variantRefValidator,
      /** A whole set's load (named for the set), or one variant (named for it). */
      wholeSet: v.boolean(),
      /** The set's cards for a whole set, the variant's for one; null when never counted. */
      cardCount: v.union(v.number(), v.null()),
      coverCardId: v.union(v.id("cardChecklist"), v.null()),
      /** When its newest card landed. */
      addedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    await requireSignedIn(ctx);
    const reader = new CatalogReader(ctx);
    type Hop = UploadHop & { set: SetRef; variant: VariantRef; setRow: OptionRow };
    const hops: Hop[] = [];
    let before: number | null = null;
    for (let hop = 0; hop < NEW_SETS_HOPS; hop++) {
      const below = before;
      const card = await ctx.db
        .query("cardChecklist")
        .withIndex("by_creation_time", (q) => (below === null ? q : q.lt("_creationTime", below)))
        .order("desc")
        .first();
      if (!card) break;
      const uploadStart = await ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", card.selectorOptionId).gte("_creationTime", card._creationTime - VARIANT_UPLOAD_MS),
        )
        .first();
      before = Math.min(card._creationTime, uploadStart?._creationTime ?? card._creationTime);

      const variant = await reader.variantRef(card.selectorOptionId);
      const set = variant ? await reader.setRef(card.selectorOptionId) : null;
      const setRow = set ? await reader.row(set._id) : null;
      if (!variant || !set || !setRow || hiddenAsEmpty(setRow)) continue;
      hops.push({
        variantId: variant._id,
        setId: set._id,
        // The Base's cards sit on the Base type itself (`variantRole`).
        isBase: variant.level === "variantType" && variant.kind === "base",
        at: card._creationTime,
        set,
        variant,
        setRow,
      });
      if (newSetsSettled(checklistLoads(hops), before, NEW_SETS_SHOWN)) break;
    }
    const out = [];
    for (const entry of checklistLoads(hops).slice(0, NEW_SETS_SHOWN)) {
      const { set, variant, setRow } = entry.opens;
      const cover = await ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option_and_sort", (q) => q.eq("selectorOptionId", variant._id))
        .first();
      const whole = entry.kind === "set";
      const count = whole ? setRow.subtreeCardCount : variant.cardCount;
      out.push({
        set,
        opens: variant,
        wholeSet: whole,
        cardCount: typeof count === "number" ? count : null,
        coverCardId: cover?._id ?? null,
        addedAt: entry.at,
      });
    }
    return out;
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
    const now = Date.now();
    const next = nextVisit(profile?.dashboardVisit, now);
    // NEO-464: the first open under the stamps dates the lines written before them (`legacyStampOf`).
    const stampsFrom = profile?.dashboardStampsFrom === undefined ? { dashboardStampsFrom: now } : {};
    if (next.write || profile?.dashboardStampsFrom === undefined) {
      if (profile) await ctx.db.patch(profile._id, { dashboardVisit: next.visit, ...stampsFrom });
      else await ctx.db.insert("userProfiles", { userId, dashboardVisit: next.visit, ...stampsFrom });
    }
    return { sinceMs: next.since };
  },
});
