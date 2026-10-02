/**
 * NEO-312 — read-only report: marketplace links held by more than one NB row.
 *
 * One marketplace link lives on one NB row (product invariant 5). Before
 * NEO-312 the sync stores could break that: "Make insert of…", "Make parallel
 * of…" and "Promote to set" move a SportLots link across variant types and
 * sets, and the next Sync Parallels / Sync Inserts — or a reconcile dialog
 * opened before the move — re-created the source row with the same link. The
 * stores now refuse to (`loadSyncHoldersElsewhere`); this report finds the
 * duplicates that already exist so an operator can fold them by hand.
 *
 * ## What counts as a duplicate (the stores' own rule)
 *
 *  - a SportLots id on two or more rows under ONE BRAND, at any level from
 *    the set down (SportLots is a flat list: one id is one set wherever it
 *    sits). A brand row's own SportLots id is a brand id, not a set's, and is
 *    not compared;
 *  - a BSC id on two or more INSERT- or PARALLEL-level rows of ONE SET. (A BSC
 *    id is a facet value of BSC's hierarchy: a set's and a variant type's are
 *    different BSC entities, and one `variantName` under two sets is two BSC
 *    sets.)
 *
 * ## Shape
 *
 * Run from the CLI as an internal action, no `--identity` (house rule:
 * `convex run --identity` cannot reach internal functions):
 *
 *   npx convex run --prod slLinkDuplicatesReport:run '{}'
 *
 * The action pages the brands one at a time (`brandsPage`), walks each brand
 * breadth-first in bounded chunks (`childrenPage`), turns that brand's
 * duplicates into output straight away and drops its rows (so the action's
 * heap holds one brand at a time), then counts the cards on each named holder
 * (`cardCounts`). Every query is small, indexed and bounded by the documents it
 * may return AND by the transaction's remaining read bytes
 * (`ctx.meta.getTransactionMetrics()`), so none nears Convex's 32k-document or
 * 16 MiB limits however big the deployment is (security audit S1/S2).
 *
 * The run stops by itself after `REPORT_TIME_BUDGET_MS` (8 minutes, inside the
 * 10-minute action timeout) or `maxBrands`, and returns `continueCursor`: pass
 * it back to resume at exactly the next brand. `truncated` says there is more
 * to read (or a brand stopped on its row bound, listed in `brandsTruncated`).
 *
 * WRITES NOTHING. No arming flag, because there is nothing to arm. The log
 * line carries counts only — never a marketplace id, label or NB name.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { slotIds } from "./platformSlots";


type RowId = Id<"selectorOptions">;
type Level = Doc<"selectorOptions">["level"];

/**
 * Brands per `brandsPage` call. One, so a run that stops on its time budget
 * mid-way resumes at exactly the next brand — never re-reading one (which
 * would report its duplicates twice) and never skipping one.
 */
export const REPORT_BRAND_PAGE = 1;
/** Parents one `childrenPage` call reads (one indexed read each). */
export const REPORT_PARENTS_PER_CALL = 200;
/** Documents one `childrenPage` call may collect, across all its parents. */
export const REPORT_DOCS_PER_CALL = 2000;
/** Rows one brand's walk may collect before the brand is reported truncated. */
export const REPORT_MAX_ROWS_PER_BRAND = 50_000;
/**
 * Rows one `cardCounts` call counts for. Five rows at `REPORT_CARD_COUNT_CAP`
 * is ~1,000 card documents — `cardChecklist` rows are several KB each, so this
 * keeps a call a few MB from the 16 MiB read limit (security audit S1).
 */
export const REPORT_CARD_ROWS_PER_CALL = 5;
/** Cards counted per row; past it the count is a floor (`cardCountCapped`). */
export const REPORT_CARD_COUNT_CAP = 200;
/**
 * Read bytes every report query leaves unread: before each further read it
 * asks Convex what is left and stops below this, handing the rest back to the
 * action. Covers the one read in flight (≤ `REPORT_DOCS_PER_CALL` rows).
 */
export const REPORT_BYTES_RESERVE = 4 * 1024 * 1024;
/** Duplicate groups returned (the total is always reported). */
export const REPORT_MAX_GROUPS = 300;
/** Holders named per group. */
export const REPORT_MAX_HOLDERS = 25;
/** Brands per run by default; `maxBrands` raises or lowers it. */
export const REPORT_DEFAULT_MAX_BRANDS = 1000;
/** Wall-clock budget per run, inside Convex's 10-minute action timeout. */
export const REPORT_TIME_BUDGET_MS = 8 * 60 * 1000;

const levelValidator = v.union(
  v.literal("sport"),
  v.literal("year"),
  v.literal("manufacturer"),
  v.literal("setName"),
  v.literal("variantType"),
  v.literal("insert"),
  v.literal("parallel"),
);

const compactRowValidator = v.object({
  id: v.id("selectorOptions"),
  level: levelValidator,
  value: v.string(),
  parentId: v.id("selectorOptions"),
  sportlots: v.array(v.string()),
  bsc: v.array(v.string()),
});
type CompactRow = {
  id: RowId;
  level: Level;
  value: string;
  parentId: RowId;
  sportlots: string[];
  bsc: string[];
};

/** Room in this query's read budget for one more read? */
async function roomToRead(ctx: { meta: { getTransactionMetrics(): Promise<{ bytesRead: { remaining: number } }> } }) {
  return (await ctx.meta.getTransactionMetrics()).bytesRead.remaining >= REPORT_BYTES_RESERVE;
}

/** One page of brands, with their year and sport names for the report. */
export const brandsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    brands: v.array(
      v.object({
        id: v.id("selectorOptions"),
        value: v.string(),
        year: v.optional(v.string()),
        sport: v.optional(v.string()),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "manufacturer"))
      .paginate({ numItems: REPORT_BRAND_PAGE, cursor: args.cursor });
    const brands = [];
    for (const brand of page.page) {
      const year = brand.parentId ? await ctx.db.get(brand.parentId) : null;
      const sport = year?.parentId ? await ctx.db.get(year.parentId) : null;
      brands.push({
        id: brand._id,
        value: brand.value,
        ...(year ? { year: year.value } : {}),
        ...(sport ? { sport: sport.value } : {}),
      });
    }
    return { brands, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * The children of a run of parents, compact (ids and NB names only).
 *
 * At most `REPORT_DOCS_PER_CALL` documents per CALL, not per parent: each
 * parent's read takes only what is left of that budget (+1 to see whether it
 * fit). A parent that does not fit is not counted as done, so the action
 * re-asks for it next call — unless it is the FIRST parent of the call, which
 * has the whole budget: then it is genuinely bigger than one call can read,
 * `overflow` says so, and the action reports the brand truncated rather than
 * under-report it. The call also stops when the transaction's remaining read
 * bytes drop below `REPORT_BYTES_RESERVE`.
 */
export const childrenPage = internalQuery({
  args: { parentIds: v.array(v.id("selectorOptions")) },
  returns: v.object({
    rows: v.array(compactRowValidator),
    parentsDone: v.number(),
    overflow: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const parentIds = args.parentIds.slice(0, REPORT_PARENTS_PER_CALL);
    const rows: CompactRow[] = [];
    let parentsDone = 0;
    let overflow = false;
    for (const parentId of parentIds) {
      const room = REPORT_DOCS_PER_CALL - rows.length;
      if (parentsDone > 0 && (room <= 0 || !(await roomToRead(ctx)))) break;
      const taken = await ctx.db
        .query("selectorOptions")
        .withIndex("by_parent", (q) => q.eq("parentId", parentId))
        .take(room + 1);
      if (taken.length > room) {
        if (parentsDone > 0) break; // re-asked next call, whole budget then
        overflow = true;
      }
      for (const child of taken.slice(0, room)) {
        rows.push({
          id: child._id,
          level: child.level,
          value: child.value,
          parentId,
          sportlots: slotIds(child, "sportlots"),
          bsc: slotIds(child, "bsc"),
        });
      }
      parentsDone++;
    }
    return { rows, parentsDone, overflow };
  },
});

/**
 * Cards on each row, counted up to `REPORT_CARD_COUNT_CAP`, for at most
 * `REPORT_CARD_ROWS_PER_CALL` rows — fewer when the read budget runs low (the
 * first row is always counted, so every call advances). Returns the rows it
 * counted, in order; the action asks again from the next one.
 */
export const cardCounts = internalQuery({
  args: { rowIds: v.array(v.id("selectorOptions")) },
  returns: v.array(
    v.object({ id: v.id("selectorOptions"), cards: v.number(), capped: v.boolean() }),
  ),
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.rowIds.slice(0, REPORT_CARD_ROWS_PER_CALL)) {
      if (out.length > 0 && !(await roomToRead(ctx))) break;
      const cards = await ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", id))
        .take(REPORT_CARD_COUNT_CAP + 1);
      out.push({
        id,
        cards: Math.min(cards.length, REPORT_CARD_COUNT_CAP),
        capped: cards.length > REPORT_CARD_COUNT_CAP,
      });
    }
    return out;
  },
});

const holderValidator = v.object({
  rowId: v.id("selectorOptions"),
  level: levelValidator,
  value: v.string(),
  /** NB names, brand › set › type › insert › parallel, ending at the row. */
  path: v.array(v.string()),
  cards: v.number(),
  cardCountCapped: v.boolean(),
});

const groupValidator = v.object({
  side: v.union(v.literal("sportlots"), v.literal("bsc")),
  marketplaceId: v.string(),
  /** "set" when every holder is in one set; "brand" when they span sets. */
  scope: v.union(v.literal("set"), v.literal("brand")),
  sport: v.optional(v.string()),
  year: v.optional(v.string()),
  holderCount: v.number(),
  holders: v.array(holderValidator),
});

type HolderOut = {
  rowId: RowId;
  level: Level;
  value: string;
  path: string[];
  cards: number;
  cardCountCapped: boolean;
};
type GroupOut = {
  side: "sportlots" | "bsc";
  marketplaceId: string;
  scope: "set" | "brand";
  sport?: string;
  year?: string;
  holderCount: number;
  holders: HolderOut[];
};

/**
 * Pure: the duplicate groups in one brand's rows. Exported for the test.
 * `rows` are every row under the brand (the brand row itself excluded).
 */
export function duplicateGroupsInBrand(
  brandId: RowId,
  rows: readonly CompactRow[],
): Array<{
  side: "sportlots" | "bsc";
  marketplaceId: string;
  scope: "set" | "brand";
  holderIds: RowId[];
}> {
  const byId = new Map<string, CompactRow>(rows.map((r) => [r.id, r]));
  const setOf = (row: CompactRow): string | null => {
    let cursor: CompactRow | undefined = row;
    for (let i = 0; cursor && i < 8; i++) {
      if (cursor.level === "setName") return cursor.id;
      if (cursor.parentId === brandId) return null;
      cursor = byId.get(cursor.parentId);
    }
    return null;
  };

  const sl = new Map<string, RowId[]>();
  const bsc = new Map<string, RowId[]>();
  const push = (map: Map<string, RowId[]>, key: string, id: RowId) => {
    const list = map.get(key);
    if (!list) map.set(key, [id]);
    else if (!list.includes(id)) list.push(id);
  };
  for (const row of rows) {
    const set = setOf(row);
    if (set === null) continue;
    for (const id of row.sportlots) push(sl, id, row.id);
    if (row.level === "insert" || row.level === "parallel") {
      for (const id of row.bsc) push(bsc, `${set}\u0000${id}`, row.id);
    }
  }

  const out: Array<{
    side: "sportlots" | "bsc";
    marketplaceId: string;
    scope: "set" | "brand";
    holderIds: RowId[];
  }> = [];
  for (const [id, holderIds] of sl) {
    if (holderIds.length < 2) continue;
    const sets = new Set(holderIds.map((h) => setOf(byId.get(h)!)));
    out.push({ side: "sportlots", marketplaceId: id, scope: sets.size === 1 ? "set" : "brand", holderIds });
  }
  for (const [key, holderIds] of bsc) {
    if (holderIds.length < 2) continue;
    out.push({
      side: "bsc",
      marketplaceId: key.slice(key.indexOf("\u0000") + 1),
      scope: "set",
      holderIds,
    });
  }
  return out;
}

function pathOf(row: CompactRow, rowsById: Map<string, CompactRow>, brandName: string): string[] {
  const names: string[] = [row.value];
  let cursor = rowsById.get(row.parentId);
  for (let i = 0; cursor && i < 8; i++) {
    names.unshift(cursor.value);
    cursor = rowsById.get(cursor.parentId);
  }
  names.unshift(brandName);
  return names;
}

export const run = internalAction({
  args: {
    /** A previous run's `continueCursor`: resume at the next brand. */
    cursor: v.optional(v.string()),
    /** Brands this run walks (default `REPORT_DEFAULT_MAX_BRANDS`). */
    maxBrands: v.optional(v.number()),
    /** Wall-clock budget in ms (default `REPORT_TIME_BUDGET_MS`). */
    timeBudgetMs: v.optional(v.number()),
  },
  returns: v.object({
    message: v.string(),
    brandsScanned: v.number(),
    rowsScanned: v.number(),
    truncated: v.boolean(),
    continueCursor: v.optional(v.string()),
    /** The run stopped on its wall-clock budget. */
    timedOut: v.boolean(),
    /** Brands whose walk stopped on `REPORT_MAX_ROWS_PER_BRAND` (ids). */
    brandsTruncated: v.array(v.id("selectorOptions")),
    groupsTotal: v.number(),
    groups: v.array(groupValidator),
    /** False when the time budget ran out before every named holder was counted. */
    cardCountsComplete: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const started = Date.now();
    const budgetMs = Math.max(0, args.timeBudgetMs ?? REPORT_TIME_BUDGET_MS);
    const overBudget = () => Date.now() - started >= budgetMs;
    const maxBrands = Math.max(1, Math.floor(args.maxBrands ?? REPORT_DEFAULT_MAX_BRANDS));
    let cursor: string | null = args.cursor ?? null;
    let brandsScanned = 0;
    let rowsScanned = 0;
    let isDone = false;
    let timedOut = false;
    const brandsTruncated: RowId[] = [];
    const groups: GroupOut[] = [];
    let groupsTotal = 0;
    let sportlotsGroups = 0;
    let bscGroups = 0;

    walk: while (brandsScanned < maxBrands) {
      // At least one brand per run, so a resumed run always advances.
      if (brandsScanned > 0 && overBudget()) {
        timedOut = true;
        break;
      }
      const page: {
        brands: Array<{ id: RowId; value: string; year?: string; sport?: string }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.slLinkDuplicatesReport.brandsPage, { cursor });
      for (const brand of page.brands) {
        const rows: CompactRow[] = [];
        let frontier: RowId[] = [brand.id];
        let brandTruncated = false;
        while (frontier.length > 0 && !brandTruncated) {
          const next: RowId[] = [];
          let offset = 0;
          while (offset < frontier.length) {
            if (brandsScanned > 0 && overBudget()) {
              // Mid-brand: drop its partial rows; `cursor` still points AT
              // this brand, so the next run walks it whole.
              timedOut = true;
              break walk;
            }
            const chunk = frontier.slice(offset, offset + REPORT_PARENTS_PER_CALL);
            const res: { rows: CompactRow[]; parentsDone: number; overflow: boolean } =
              await ctx.runQuery(internal.slLinkDuplicatesReport.childrenPage, {
                parentIds: chunk,
              });
            offset += Math.max(1, res.parentsDone);
            if (res.overflow) brandTruncated = true;
            for (const row of res.rows) {
              rows.push(row);
              if (row.level !== "parallel") next.push(row.id);
            }
            if (rows.length > REPORT_MAX_ROWS_PER_BRAND) brandTruncated = true;
            if (brandTruncated) break;
          }
          frontier = next;
        }
        brandsScanned++;
        rowsScanned += rows.length;
        if (brandTruncated) {
          brandsTruncated.push(brand.id);
          continue;
        }
        // This brand's output, built now; its rows go out of scope after.
        const rowsById = new Map<string, CompactRow>(rows.map((r) => [r.id, r]));
        for (const g of duplicateGroupsInBrand(brand.id, rows)) {
          groupsTotal++;
          if (g.side === "sportlots") sportlotsGroups++;
          else bscGroups++;
          if (groups.length >= REPORT_MAX_GROUPS) continue;
          groups.push({
            side: g.side,
            marketplaceId: g.marketplaceId,
            scope: g.scope,
            ...(brand.sport ? { sport: brand.sport } : {}),
            ...(brand.year ? { year: brand.year } : {}),
            holderCount: g.holderIds.length,
            holders: g.holderIds.slice(0, REPORT_MAX_HOLDERS).map((id) => {
              const row = rowsById.get(id)!;
              return {
                rowId: id,
                level: row.level,
                value: row.value,
                path: pathOf(row, rowsById, brand.value),
                cards: 0,
                cardCountCapped: false,
              };
            }),
          });
        }
      }
      if (page.isDone) {
        isDone = true;
        break;
      }
      cursor = page.continueCursor;
    }

    // Cards on the named holders, a few rows per call, inside the same budget.
    const wanted = [...new Set(groups.flatMap((g) => g.holders.map((h) => h.rowId)))];
    const counts = new Map<string, { cards: number; capped: boolean }>();
    let cardCountsComplete = true;
    for (let i = 0; i < wanted.length; ) {
      if (overBudget()) {
        cardCountsComplete = false;
        timedOut = true;
        break;
      }
      const res: Array<{ id: RowId; cards: number; capped: boolean }> = await ctx.runQuery(
        internal.slLinkDuplicatesReport.cardCounts,
        { rowIds: wanted.slice(i, i + REPORT_CARD_ROWS_PER_CALL) },
      );
      for (const c of res) counts.set(c.id, { cards: c.cards, capped: c.capped });
      i += Math.max(1, res.length);
    }
    for (const g of groups) {
      for (const h of g.holders) {
        const c = counts.get(h.rowId);
        if (c) {
          h.cards = c.cards;
          h.cardCountCapped = c.capped;
        }
      }
    }

    const truncated = !isDone || brandsTruncated.length > 0;
    console.log(
      JSON.stringify({
        msg: "report_marketplace_link_duplicates",
        brandsScanned,
        rowsScanned,
        groupsTotal,
        sportlotsGroups,
        bscGroups,
        brandsTruncated: brandsTruncated.length,
        truncated,
        timedOut,
        cardCountsComplete,
        durationMs: Date.now() - started,
      }),
    );

    return {
      message:
        "Report only — nothing written. Each group is one marketplace id on " +
        "more than one NB row; which row keeps it is the operator's decision." +
        (!isDone
          ? " The run stopped before the last brand: pass continueCursor to resume."
          : "") +
        (brandsTruncated.length > 0
          ? " Some brands were too big to walk whole: see brandsTruncated."
          : "") +
        (!cardCountsComplete ? " Card counts are incomplete (time budget)." : ""),
      brandsScanned,
      rowsScanned,
      truncated,
      ...(!isDone && cursor !== null ? { continueCursor: cursor } : {}),
      timedOut,
      brandsTruncated,
      groupsTotal,
      groups,
      cardCountsComplete,
    };
  },
});
