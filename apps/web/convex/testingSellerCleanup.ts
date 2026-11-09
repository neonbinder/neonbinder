/**
 * NEO-445 — clears the shared test sellers before the marketplace-seller specs,
 * so those specs always start clean.
 *
 * Every PR's CI lists on one BuySportsCards seller and one eBay sandbox seller.
 * A run that dies mid-spec leaves listings up, and no later run can end them
 * through the product: an eBay SKU carries a per-deployment card id, and a BSC
 * row a run never knew about is only zeroed by that set's own Sync. So
 * `e2e.yml`'s two seller jobs call this action, inside their turn in the seller
 * queue, before any spec. It never runs in the seed: seeds run outside the queue.
 *
 * Scope (Jason, NEO-445). Only the accounts the specs use: the bootstrap's own
 * `DEV_BSC_USERNAME` / `DEV_BSC_PASSWORD` and `DEV_EBAY_REFRESH_TOKEN`
 * (`testing.seedMyTestCredentials`).
 *
 * - eBay: empties the sandbox seller's inventory (NEO-453). Pages the inventory,
 *   withdraws every PUBLISHED offer, then deletes every item, which takes its
 *   unpublished offers with it (Sell Inventory contract). Withdrawing first is
 *   what makes "ended" provable: the delete is documented to end a listing too,
 *   but only the withdraw answers for it, and the sandbox has strayed from the
 *   contract before. An item whose offer could not be read or ended is NOT
 *   deleted: the item is the only way a later run can find that listing.
 *   Policies stay: the listing spec needs the seller's own shipping policies.
 * - BSC: sets quantity to 0 on ALL of the seller's rows, in the conditions the
 *   specs list in (`SellerSpecSet.conditions`), for each set the specs list
 *   (`SELLER_SPEC_SETS`) that this deployment has, the rest of the account
 *   untouched (NEO-475: the drain reads only the conditions NB uses, so a
 *   spec lists only in those, and a sheet read costs a cold BSC up to 30 s). A set its spec builds, not built here yet, is skipped and counted
 *   (`skippedSets`): its rows on BSC are left as they are, even when the report
 *   says "clean". A chain with two rows of one name fails. Reads those sheets
 *   one at a time (`listingDrain.readSheets`, the drain's own scope and
 *   rule; a 503 is retried after each of `BSC_CLEANUP_SHEET_RETRY_PAUSES_MS`),
 *   PUTs every row above 0 to 0, then reads back. A direct write, so the
 *   planner's `duplicate_sheet_row` never blocks it: both copies of a twin go to
 *   0 like any other row. Rows are never removed. If BSC goes on showing both
 *   copies at 0, `planBscSheet` still refuses a card listed in that condition
 *   (it keys on the pair, whatever the quantity), so that is reported, not
 *   failed: a spec listing another card or condition is unaffected.
 *
 * The sign-ins belong to `CLEANUP_OWNER`, not a worker: no spec's session is
 * touched and the worker's bootstrap runs later, in the spec step. The owner
 * marks itself not listing (`testOff`), so it never holds a seller account, and
 * its session and rows are removed at the end. A fixed id on purpose: a session
 * a crash leaves behind is overwritten by the next run rather than piling up.
 *
 * Failing: a side that cannot finish fails the action, after the other side has
 * run, so the job stops on a clear message rather than running specs on a dirty
 * account. A paused marketplace (`NEONBINDER_PAUSED_PLATFORMS`) is skipped and
 * never contacted. Logs carry counts and outcomes, never a token.
 *
 * Internal: reachable only with the deploy key (`npx convex run`), and fails
 * closed without `TESTING_RESET_SECRET` and off the eBay sandbox.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  deleteInventoryItem,
  getInventorySkusPage,
  getOfferBySku,
  isBusyAnswer,
  openEbaySellerSession,
  withdrawOffer,
  EBAY_PUBLISH_RETRY_PAUSE_MS,
  type EbayFailure,
  type EbayResult,
  type EbaySellerSession,
} from "./adapters/ebaySeller";
import {
  closeBscSellerSession,
  fetchBscSellerId,
  openBscSellerSession,
  putBscListings,
  type BscSellerSession,
} from "./adapters/bscSeller";
import { ebayConfig } from "./lib/ebayEnv";
import { isBscConditionOfEra, type BscRawCondition } from "./lib/bscConditions";
import { chunkRows, photoKeyFor, type BscSheetRow } from "./lib/bscSheetPlan";
import { isPlatformPaused } from "./marketplacePause";
import { readSheets, type VariantInput } from "./listingDrain";
import { variantTypeKindFromTitle } from "./variantRole";

/**
 * A real set a seller spec lists on. Its cards are in the set's Base, or, with
 * `parallel`, in that parallel of the set's Parallel type, or, with `insert`, in
 * that insert of the set's Insert type. Never both a parallel and an insert.
 */
export type SellerSpecSet = {
  sport: string;
  year: string;
  manufacturer: string;
  setName: string;
  /** The parallel (a row of the set's Parallel type) that holds the cards, instead of Base. */
  parallel?: string;
  /** The insert (a row of the set's Insert type) that holds the cards, instead of Base. */
  insert?: string;
  /**
   * The BSC raw conditions the specs list this set in: the only sheets cleared.
   * A spec's copy has NB's default condition (Excellent), so this is that
   * condition in the set's era (`bscConditionFor`); a spec that lists in another
   * condition adds it here, or its rows are never cleared.
   */
  conditions: readonly BscRawCondition[];
  /**
   * The spec builds this set itself, in-flow, so a deployment the seed just reset
   * does not have it yet: absent is skipped, never a failure. (A set the seed
   * provisions stays fail-closed: its absence means the seed did not run.) Two
   * rows of one name fail either way.
   */
  builtBySpec?: boolean;
};

/**
 * Every real set the seller specs list on (`playwright/SET-REGISTRY.md`). The
 * BuySportsCards and eBay sandbox specs share the first (NEO-475): the seed
 * builds it, and they list at a common price no buyer pays, so nothing sells.
 */
export const SELLER_SPEC_SETS: readonly SellerSpecSet[] = [
  {
    sport: "Baseball",
    year: "2024",
    manufacturer: "Topps",
    setName: "Topps Chrome",
    insert: "Future Stars",
    conditions: ["excellent"],
  },
  // NEO-458: 2026 Bowman Chrome, whose BSC numbers carry a `BCV-` prefix NB's do not.
  {
    sport: "Football",
    year: "2026",
    manufacturer: "Bowman",
    setName: "Bowman",
    parallel: "Chrome",
    builtBySpec: true,
    conditions: ["excellent"],
  },
];

/** Whose sign-ins this holds while it works. Clerk's id shape; no Clerk user has it. */
const CLEANUP_OWNER = "user_e2esellercleanup";

/** eBay's pages hold `EBAY_INVENTORY_PAGE` items: 20,000 is far above this seller. */
const MAX_INVENTORY_PAGES = 200;
/** SKUs worked side by side: each run clears what the last left, but a first run meets hundreds. */
const EBAY_CONCURRENCY = 8;
/**
 * Under Convex's 10 minute action limit, leaving room for the BSC side and
 * tidying up. Deleted items never come back, so a run out of time still leaves
 * less for the re-run its failure asks for.
 */
const EBAY_BUDGET_MS = 5 * 60 * 1000;
/**
 * The waits before a 503'd sheet read is tried again (`readSheets`, shared by
 * one call). Longer than the drain's: CI's seller job meets BSC cold, and BSC
 * was seen to take one to three minutes to warm. Each retry starts only after
 * the 503 answered, so nothing overlaps.
 */
export const BSC_CLEANUP_SHEET_RETRY_PAUSES_MS: readonly number[] = [10_000, 30_000, 60_000];
/** Rows read under one parent when walking a chain. A full read can't say a name is absent or single. */
export const MAX_CHAIN_SIBLINGS = 1000;

const chainLevelValidator = v.union(
  v.literal("sport"),
  v.literal("year"),
  v.literal("manufacturer"),
  v.literal("setName"),
  v.literal("variantType"),
  v.literal("insert"),
);

const variantLookupValidator = v.union(
  v.object({ kind: v.literal("found"), id: v.id("selectorOptions") }),
  v.object({ kind: v.literal("absent") }),
  v.object({ kind: v.literal("ambiguous"), level: chainLevelValidator }),
);
type VariantLookup = typeof variantLookupValidator.type;
type ChainLevel = typeof chainLevelValidator.type;

/**
 * The row of one set the specs list that holds its cards: the set's Base, with
 * `parallel` that parallel of its Parallel type, or with `insert` that insert of
 * its Insert type. "absent" when a row of the chain isn't there, "ambiguous" when
 * one can't be told apart: never picks one. Both a parallel and an insert throws.
 */
export const variantOf = internalQuery({
  args: {
    sport: v.string(),
    year: v.string(),
    manufacturer: v.string(),
    setName: v.string(),
    parallel: v.optional(v.string()),
    insert: v.optional(v.string()),
  },
  returns: variantLookupValidator,
  handler: async (ctx, args): Promise<VariantLookup> => {
    const childNamed = async (
      level: ChainLevel,
      parentId: Id<"selectorOptions"> | undefined,
      matches: (value: string) => boolean,
    ): Promise<VariantLookup> => {
      const rows = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) => q.eq("level", level).eq("parentId", parentId))
        .take(MAX_CHAIN_SIBLINGS);
      const hits = rows.filter((row) => matches(row.value));
      if (hits.length > 1 || rows.length >= MAX_CHAIN_SIBLINGS) return { kind: "ambiguous", level };
      return hits.length === 1 ? { kind: "found", id: hits[0]._id } : { kind: "absent" };
    };
    const sport = await childNamed("sport", undefined, (value) => value === args.sport);
    if (sport.kind !== "found") return sport;
    const year = await childNamed("year", sport.id, (value) => value === args.year);
    if (year.kind !== "found") return year;
    const brand = await childNamed("manufacturer", year.id, (value) => value === args.manufacturer);
    if (brand.kind !== "found") return brand;
    const set = await childNamed("setName", brand.id, (value) => value === args.setName);
    if (set.kind !== "found") return set;
    const { parallel, insert } = args;
    if (parallel !== undefined && insert !== undefined) {
      throw new Error(`${args.year} ${args.manufacturer} ${args.setName} names a parallel and an insert: a spec's cards are in one row`);
    }
    const child = parallel ?? insert;
    if (child === undefined) {
      return await childNamed("variantType", set.id, (value) => variantTypeKindFromTitle(value) === "base");
    }
    const kind = parallel !== undefined ? "parallel" : "insert";
    const type = await childNamed("variantType", set.id, (value) => variantTypeKindFromTitle(value) === kind);
    if (type.kind !== "found") return type;
    return await childNamed("insert", type.id, (value) => value === child);
  },
});

/** Removes every row `CLEANUP_OWNER` picked up on the way. Takes no owner: it can name no one else. */
export const forgetCleanupOwner = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const states = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", CLEANUP_OWNER))
      .collect();
    for (const row of states) await ctx.db.delete(row._id);
    const settings = await ctx.db
      .query("ebaySellerSettings")
      .withIndex("by_owner", (q) => q.eq("ownerId", CLEANUP_OWNER))
      .collect();
    for (const row of settings) await ctx.db.delete(row._id);
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", CLEANUP_OWNER))
      .collect();
    for (const row of profiles) await ctx.db.delete(row._id);
    return null;
  },
});

const ebayReportValidator = v.object({
  outcome: v.union(v.literal("clean"), v.literal("paused")),
  /** Items read from the seller's inventory, each checked for a live offer. */
  items: v.number(),
  withdrawn: v.number(),
  /** Items removed from the seller; one eBay no longer has counts. */
  deleted: v.number(),
});
type EbayReport = typeof ebayReportValidator.type;

const bscReportValidator = v.object({
  outcome: v.union(v.literal("clean"), v.literal("paused")),
  rows: v.number(),
  unreadableRows: v.number(),
  /** Rows above 0 when this started, and what the PUTs took to 0. */
  listed: v.number(),
  zeroed: v.number(),
  twinKeys: v.number(),
  /** Two rows still on the sheet for one (card, condition), at 0: `planBscSheet` refuses that pair. */
  twinKeysRemaining: v.number(),
  /** Sets its spec builds that this deployment doesn't have yet: not read, so not cleared. */
  skippedSets: v.number(),
});
type BscReport = typeof bscReportValidator.type;

function isOurRow(row: BscSheetRow): boolean {
  // As the planner: a slab row is never ours.
  return row.productType === null || row.productType === "raw";
}

function countTwinKeys(rows: readonly BscSheetRow[]): number {
  const seen = new Set<string>();
  const twins = new Set<string>();
  for (const row of rows) {
    const key = photoKeyFor(row.bscCardId, row.condition);
    if (seen.has(key)) twins.add(key);
    seen.add(key);
  }
  return twins.size;
}

/** Runs `work` over `items`, at most `limit` at once, and stops starting more once `stop` is true. */
async function eachSideBySide<T>(
  items: readonly T[],
  limit: number,
  stop: () => boolean,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length && !stop()) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
}

/** One more try when eBay says it is busy: the sandbox has answered single calls 500. */
async function onceMoreIfBusy<T>(call: () => Promise<EbayResult<T>>): Promise<EbayResult<T>> {
  const first = await call();
  if (first.ok || !isBusyAnswer(first.failure)) return first;
  await new Promise<void>((resolve) => setTimeout(resolve, EBAY_PUBLISH_RETRY_PAUSE_MS));
  return await call();
}

function saysEbay(f: EbayFailure): string {
  const ids = f.errorIds && f.errorIds.length > 0 ? `, eBay errors ${f.errorIds.join(" ")}` : "";
  return `${f.message} (${f.kind}${f.httpStatus !== undefined ? ` ${f.httpStatus}` : ""}${ids})`;
}

async function clearEbay(ctx: ActionCtx): Promise<EbayReport> {
  const refreshToken = process.env.DEV_EBAY_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("DEV_EBAY_REFRESH_TOKEN is not set on this deployment");
  const startedAt = Date.now();
  // The same refresh exchange the spec's seed hop makes (`connectEbay`).
  const connected = await ctx.runAction(internal.credentials.connectEbay, {
    userId: CLEANUP_OWNER,
    refreshToken,
    listing: "testOff",
  });
  if (!connected.ok) throw new Error(`could not connect the sandbox seller (${connected.error})`);

  const opened = await openEbaySellerSession(ctx, CLEANUP_OWNER);
  if (!opened.ok) throw new Error(`could not open a session: ${saysEbay(opened.failure)}`);
  const session: EbaySellerSession = opened.value;

  const skus: string[] = [];
  const offsets = new Set<string>();
  for (let offset: string | null = "0"; offset !== null; ) {
    if (offsets.has(offset) || offsets.size >= MAX_INVENTORY_PAGES) {
      throw new Error(`stopped paging the seller's inventory at page ${offsets.size}: the listing is not complete`);
    }
    offsets.add(offset);
    const asked: string = offset;
    const page = await onceMoreIfBusy(() => getInventorySkusPage(ctx, session, asked));
    if (!page.ok) throw new Error(`could not read the seller's inventory: ${saysEbay(page.failure)}`);
    // An item NB can't name may hold a live listing, so "all ended" can't be said.
    if (page.value.unreadable > 0) throw new Error(`${page.value.unreadable} inventory items came back with no readable SKU`);
    skus.push(...page.value.skus);
    offset = page.value.nextOffset;
  }

  let withdrawn = 0;
  let deleted = 0;
  let notEnded = 0;
  let notDeleted = 0;
  let firstFailure: string | null = null;
  let firstDeleteFailure: string | null = null;
  const note = (f: EbayFailure) => {
    notEnded += 1;
    firstFailure ??= saysEbay(f);
  };
  const outOfTime = () => Date.now() - startedAt > EBAY_BUDGET_MS;
  await eachSideBySide(
    skus,
    EBAY_CONCURRENCY,
    () => session.dead || outOfTime(),
    async (sku) => {
      // Not ended, or not known to be: keep the item, a re-run finds the listing through it.
      const offer = await onceMoreIfBusy(() => getOfferBySku(ctx, session, sku));
      if (!offer.ok) return note(offer.failure);
      if (offer.value?.published) {
        const { offerId } = offer.value;
        const r = await onceMoreIfBusy(() => withdrawOffer(ctx, session, offerId));
        // 404: eBay no longer has it live.
        if (!r.ok && r.failure.httpStatus !== 404) return note(r.failure);
        withdrawn += 1;
      }
      // Calls under way run on past the budget: don't add a slow one to them.
      if (outOfTime()) return;
      const gone = await onceMoreIfBusy(() => deleteInventoryItem(ctx, session, sku));
      if (gone.ok) {
        deleted += 1;
      } else {
        notDeleted += 1;
        firstDeleteFailure ??= saysEbay(gone.failure);
      }
    },
  );
  if (session.dead) throw new Error("eBay refused the session part-way through");
  if (outOfTime()) {
    throw new Error(`ran out of time with ${skus.length} items to clear, ${withdrawn} withdrawn and ${deleted} deleted; re-run the workflow to finish the rest`);
  }
  const refused = [
    ...(notEnded > 0 ? [`${notEnded} of ${skus.length} items could not be checked or withdrawn, so they were kept: ${firstFailure}`] : []),
    ...(notDeleted > 0 ? [`${notDeleted} of ${skus.length} items could not be deleted: ${firstDeleteFailure}`] : []),
  ];
  if (refused.length > 0) throw new Error(refused.join("; "));
  return { outcome: "clean", items: skus.length, withdrawn, deleted };
}

/** A set's scope, and the spec conditions to clear in it. */
type SetToClear = { input: Extract<VariantInput, { kind: "ok" }>; conditions: readonly string[] };

const SHEET_RETRY = { pausesMs: BSC_CLEANUP_SHEET_RETRY_PAUSES_MS };

/** Sets every row of one set's spec-condition sheets to 0 and proves it by reading back. */
async function zeroSet(
  ctx: ActionCtx,
  session: BscSellerSession,
  sellerIdOf: () => Promise<string>,
  { input, conditions }: SetToClear,
): Promise<Omit<BscReport, "outcome" | "skippedSets">> {
  // Serial, never side by side: overlapping sheet reads are what mint twin rows.
  const first = await readSheets(ctx, session, input.requests, conditions, undefined, SHEET_RETRY);
  if (!first.ok) throw new Error(`could not read the sheets: ${first.failure.message}`);
  const rows = first.sheet.rows.filter(isOurRow);
  const twinKeys = countTwinKeys(rows);
  const listed = rows.filter((row) => row.quantity > 0);
  const report = { rows: rows.length, unreadableRows: first.sheet.unreadable, listed: listed.length, twinKeys };
  if (listed.length === 0) return { ...report, zeroed: 0, twinKeysRemaining: twinKeys };

  const sellerId = await sellerIdOf();
  let putFailure: string | null = null;
  const puts = listed.map((row) => ({ ...row.raw, condition: row.condition, availableQuantity: 0 }));
  for (const chunk of chunkRows(puts)) {
    const put = await putBscListings(ctx, session, { sellerId, listings: chunk });
    if (!put.ok) putFailure ??= put.failure.message;
  }

  // BSC's PUT answer is not proof: read back every sheet the PUTs touched.
  const touched = new Set(listed.map((row) => row.condition));
  const back = await readSheets(
    ctx,
    session,
    input.requests,
    conditions.filter((c) => touched.has(c)),
    undefined,
    SHEET_RETRY,
  );
  if (!back.ok) throw new Error(`could not read the sheets back: ${back.failure.message}`);
  const backRows = back.sheet.rows.filter(isOurRow);
  const stillListed = backRows.filter((row) => row.quantity > 0).length;
  if (stillListed > 0) {
    throw new Error(`${stillListed} rows are still above 0 after the PUT${putFailure ? ` (${putFailure})` : ""}`);
  }
  const final = [...rows.filter((row) => !touched.has(row.condition)), ...backRows];
  return { ...report, zeroed: listed.length, twinKeysRemaining: countTwinKeys(final) };
}

async function clearBsc(ctx: ActionCtx): Promise<BscReport> {
  const username = process.env.DEV_BSC_USERNAME;
  const password = process.env.DEV_BSC_PASSWORD;
  if (!username || !password) throw new Error("DEV_BSC_USERNAME or DEV_BSC_PASSWORD is not set on this deployment");

  // Every set's scope first: a set that can't be found signs in to nothing.
  const inputs: SetToClear[] = [];
  let skippedSets = 0;
  for (const { builtBySpec, conditions, ...scope } of SELLER_SPEC_SETS) {
    const where = scope.parallel ?? scope.insert ?? "Base";
    const name = `${scope.year} ${scope.manufacturer} ${scope.setName}`;
    const found: VariantLookup = await ctx.runQuery(internal.testingSellerCleanup.variantOf, scope);
    if (found.kind === "ambiguous") {
      throw new Error(`${name} ${where} can't be told apart: its ${found.level} row isn't there exactly once`);
    }
    if (found.kind === "absent") {
      // Built by its spec and not built yet on this deployment: nothing of it to clear here.
      if (builtBySpec) {
        skippedSets += 1;
        console.log(
          JSON.stringify({
            msg: "seller_cleanup_set_absent",
            platform: "bsc",
            operation: "clearSellerAccounts",
            set: `${scope.sport} ${name} ${where}`,
          }),
        );
        continue;
      }
      throw new Error(`no ${name} ${where} on this deployment: did the seed run?`);
    }
    const input: VariantInput = await ctx.runQuery(internal.listingDrain.variantSyncInput, {
      ownerId: CLEANUP_OWNER,
      variantId: found.id,
    });
    if (input.kind !== "ok") throw new Error(`${name} ${where} has no BuySportsCards scope (${input.kind})`);
    // A condition of the other era would stamp a sheet BSC never shows this set's rows under.
    const wrongEra = conditions.filter((c) => !isBscConditionOfEra(c, input.era));
    if (wrongEra.length > 0) {
      throw new Error(`${name} ${where} is ${input.era} on BuySportsCards, but its spec conditions include ${wrongEra.join(", ")}`);
    }
    inputs.push({ input, conditions });
  }

  const stored = await ctx.runAction(internal.credentials.storeTestCredentials, {
    userId: CLEANUP_OWNER,
    site: "buysportscards",
    username,
    password,
    listing: false,
  });
  if (!stored.success) throw new Error(`could not sign in: ${stored.message}`);

  const opened = await openBscSellerSession(ctx, CLEANUP_OWNER, { op: "clearSellerAccounts" });
  if (!opened.ok) throw new Error(`could not open a session: ${opened.failure.message}`);
  const session = opened.value;
  try {
    // The seller this session is signed in as: the only one a PUT here names.
    let known: string | null = null;
    const sellerIdOf = async (): Promise<string> => {
      if (known !== null) return known;
      const sellerId = await fetchBscSellerId(ctx, session);
      if (!sellerId.ok) throw new Error(`could not read the seller id: ${sellerId.failure.message}`);
      if (sellerId.value === null) throw new Error("BuySportsCards didn't say which seller account this is");
      known = sellerId.value;
      return known;
    };

    const total: BscReport = { outcome: "clean", rows: 0, unreadableRows: 0, listed: 0, zeroed: 0, twinKeys: 0, twinKeysRemaining: 0, skippedSets };
    for (const set of inputs) {
      const one = await zeroSet(ctx, session, sellerIdOf, set);
      total.rows += one.rows;
      total.unreadableRows += one.unreadableRows;
      total.listed += one.listed;
      total.zeroed += one.zeroed;
      total.twinKeys += one.twinKeys;
      total.twinKeysRemaining += one.twinKeysRemaining;
    }
    return total;
  } finally {
    // NEO-475: the session's BSC call summary, once per cleanup. Never throws.
    await closeBscSellerSession(ctx, session);
  }
}

/** One side's work, its sign-in removed whatever happened. Null report: failed, with `error`. */
async function runSide<R extends { outcome: string }>(
  ctx: ActionCtx,
  platform: "ebay" | "bsc",
  site: "ebay" | "buysportscards",
  work: () => Promise<R>,
): Promise<{ report: R; error: null } | { report: null; error: string }> {
  const startedAt = Date.now();
  let result: { report: R; error: null } | { report: null; error: string };
  try {
    result = { report: await work(), error: null };
  } catch (err) {
    result = { report: null, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const removed = await ctx.runAction(internal.credentials.removeTestCredentials, { userId: CLEANUP_OWNER, site });
    // The next run overwrites it: worth a line, not a failed job.
    if (!removed.ok) {
      console.warn(JSON.stringify({ msg: "seller_cleanup_session_left", platform, operation: "removeSession" }));
    }
  } catch {
    console.warn(JSON.stringify({ msg: "seller_cleanup_session_left", platform, operation: "removeSession" }));
  }
  console.log(
    JSON.stringify({
      msg: "seller_cleanup",
      platform,
      operation: "clearSellerAccounts",
      durationMs: Date.now() - startedAt,
      ...(result.report ?? { outcome: "failed", error: result.error }),
    }),
  );
  return result;
}

/**
 * Clears both test sellers (top of file). Throws when a side could not finish,
 * naming it, which fails the workflow step.
 */
export const clearSellerAccounts = internalAction({
  args: {},
  returns: v.object({ ebay: ebayReportValidator, bsc: bscReportValidator }),
  handler: async (ctx): Promise<{ ebay: EbayReport; bsc: BscReport }> => {
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Seller cleanup is not enabled on this deployment");
    }
    const ebayPaused = isPlatformPaused("ebay");
    const bscPaused = isPlatformPaused("buysportscards");
    // Before either side touches anything: nothing here may ever reach real eBay.
    if (!ebayPaused && ebayConfig()?.environment !== "sandbox") {
      throw new Error("Seller cleanup refused: this deployment's eBay is not the sandbox (EBAY_ENVIRONMENT)");
    }
    const ebay = ebayPaused
      ? { report: { outcome: "paused", items: 0, withdrawn: 0, deleted: 0 } satisfies EbayReport, error: null }
      : await runSide<EbayReport>(ctx, "ebay", "ebay", () => clearEbay(ctx));
    const bsc = bscPaused
      ? {
          report: { outcome: "paused", rows: 0, unreadableRows: 0, listed: 0, zeroed: 0, twinKeys: 0, twinKeysRemaining: 0, skippedSets: 0 } satisfies BscReport,
          error: null,
        }
      : await runSide<BscReport>(ctx, "bsc", "buysportscards", () => clearBsc(ctx));
    await ctx.runMutation(internal.testingSellerCleanup.forgetCleanupOwner, {});

    if (ebay.report === null || bsc.report === null) {
      const failures = [
        ...(ebay.error !== null ? [`eBay: ${ebay.error}`] : []),
        ...(bsc.error !== null ? [`BuySportsCards: ${bsc.error}`] : []),
      ];
      throw new Error(`Seller cleanup failed, so the accounts may not be clean. ${failures.join(". ")}`);
    }
    return { ebay: ebay.report, bsc: bsc.report };
  },
});
