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
 * The action pages the brands (`brandsPage`), walks each brand breadth-first in
 * bounded chunks (`childrenPage`), groups the ids in memory, then counts the
 * cards on each holder (`cardCounts`). Every query is small and indexed, so no
 * transaction nears Convex's read limits however big the deployment is. Pass
 * a previous run's `continueCursor` to resume at the next brand; `truncated`
 * says the run stopped on `maxBrands` (or a brand stopped on its row bound,
 * listed in `brandsTruncated`).
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

/** Brands per `brandsPage` call. */
export const REPORT_BRAND_PAGE = 50;
/** Parents one `childrenPage` call reads (one indexed read each). */
export const REPORT_PARENTS_PER_CALL = 200;
/** Documents one `childrenPage` call may collect before it hands back. */
export const REPORT_DOCS_PER_CALL = 4000;
/** Rows one brand's walk may collect before the brand is reported truncated. */
export const REPORT_MAX_ROWS_PER_BRAND = 50_000;
/** Rows one `cardCounts` call counts for. */
export const REPORT_CARD_ROWS_PER_CALL = 100;
/** Cards counted per row; past it the count is a floor (`cardCountCapped`). */
export const REPORT_CARD_COUNT_CAP = 1000;
/** Duplicate groups returned (the total is always reported). */
export const REPORT_MAX_GROUPS = 300;
/** Holders named per group. */
export const REPORT_MAX_HOLDERS = 25;
/** Brands per run by default; `maxBrands` raises or lowers it. */
export const REPORT_DEFAULT_MAX_BRANDS = 1000;

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
 * The children of a run of parents, compact (ids and NB names only). Stops
 * early on `REPORT_DOCS_PER_CALL` and says how many parents it finished, so
 * the action resumes at the next one. A single parent with more children than
 * that bound is not read past it; `overflow` says so and the action reports
 * the brand as truncated rather than under-report it.
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
      if (parentsDone > 0 && rows.length >= REPORT_DOCS_PER_CALL) break;
      const taken = await ctx.db
        .query("selectorOptions")
        .withIndex("by_parent", (q) => q.eq("parentId", parentId))
        .take(REPORT_DOCS_PER_CALL + 1);
      if (taken.length > REPORT_DOCS_PER_CALL) overflow = true;
      const children = taken.slice(0, REPORT_DOCS_PER_CALL);
      for (const child of children) {
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

/** Cards on each row, counted up to `REPORT_CARD_COUNT_CAP`. */
export const cardCounts = internalQuery({
  args: { rowIds: v.array(v.id("selectorOptions")) },
  returns: v.array(
    v.object({ id: v.id("selectorOptions"), cards: v.number(), capped: v.boolean() }),
  ),
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.rowIds.slice(0, REPORT_CARD_ROWS_PER_CALL)) {
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

type Group = {
  side: "sportlots" | "bsc";
  marketplaceId: string;
  scope: "set" | "brand";
  sport?: string;
  year?: string;
  holderCount: number;
  holderIds: RowId[];
  rowsById: Map<string, CompactRow>;
  brandName: string;
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
  },
  returns: v.object({
    message: v.string(),
    brandsScanned: v.number(),
    rowsScanned: v.number(),
    truncated: v.boolean(),
    continueCursor: v.optional(v.string()),
    /** Brands whose walk stopped on `REPORT_MAX_ROWS_PER_BRAND` (ids). */
    brandsTruncated: v.array(v.id("selectorOptions")),
    groupsTotal: v.number(),
    groups: v.array(groupValidator),
  }),
  handler: async (ctx, args) => {
    const started = Date.now();
    const maxBrands = Math.max(1, Math.floor(args.maxBrands ?? REPORT_DEFAULT_MAX_BRANDS));
    let cursor: string | null = args.cursor ?? null;
    let brandsScanned = 0;
    let rowsScanned = 0;
    let isDone = false;
    const brandsTruncated: RowId[] = [];
    const groups: Group[] = [];

    // `maxBrands` is checked per PAGE, so a run never stops inside one and a
    // resumed run never re-reads a brand (a run may exceed it by < a page).
    while (brandsScanned < maxBrands) {
      const page: {
        brands: Array<{ id: RowId; value: string; year?: string; sport?: string }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.slLinkDuplicatesReport.brandsPage, { cursor });
      for (const brand of page.brands) {
        brandsScanned++;
        const rows: CompactRow[] = [];
        let frontier: RowId[] = [brand.id];
        let brandTruncated = false;
        while (frontier.length > 0 && !brandTruncated) {
          const next: RowId[] = [];
          let offset = 0;
          while (offset < frontier.length) {
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
        rowsScanned += rows.length;
        if (brandTruncated) {
          brandsTruncated.push(brand.id);
          continue;
        }
        const rowsById = new Map<string, CompactRow>(rows.map((r) => [r.id, r]));
        for (const g of duplicateGroupsInBrand(brand.id, rows)) {
          groups.push({
            ...g,
            ...(brand.sport ? { sport: brand.sport } : {}),
            ...(brand.year ? { year: brand.year } : {}),
            holderCount: g.holderIds.length,
            rowsById,
            brandName: brand.value,
          });
        }
      }
      if (page.isDone) {
        isDone = true;
        break;
      }
      cursor = page.continueCursor;
    }

    // Cards on the holders that will be named.
    const named = groups.slice(0, REPORT_MAX_GROUPS);
    const wanted = [
      ...new Set(named.flatMap((g) => g.holderIds.slice(0, REPORT_MAX_HOLDERS))),
    ];
    const counts = new Map<string, { cards: number; capped: boolean }>();
    for (let i = 0; i < wanted.length; i += REPORT_CARD_ROWS_PER_CALL) {
      const res: Array<{ id: RowId; cards: number; capped: boolean }> = await ctx.runQuery(
        internal.slLinkDuplicatesReport.cardCounts,
        { rowIds: wanted.slice(i, i + REPORT_CARD_ROWS_PER_CALL) },
      );
      for (const c of res) counts.set(c.id, { cards: c.cards, capped: c.capped });
    }

    const out = named.map((g) => ({
      side: g.side,
      marketplaceId: g.marketplaceId,
      scope: g.scope,
      ...(g.sport ? { sport: g.sport } : {}),
      ...(g.year ? { year: g.year } : {}),
      holderCount: g.holderCount,
      holders: g.holderIds.slice(0, REPORT_MAX_HOLDERS).map((id) => {
        const row = g.rowsById.get(id)!;
        const c = counts.get(id) ?? { cards: 0, capped: false };
        return {
          rowId: id,
          level: row.level,
          value: row.value,
          path: pathOf(row, g.rowsById, g.brandName),
          cards: c.cards,
          cardCountCapped: c.capped,
        };
      }),
    }));

    const truncated = !isDone || brandsTruncated.length > 0;
    console.log(
      JSON.stringify({
        msg: "report_marketplace_link_duplicates",
        brandsScanned,
        rowsScanned,
        groupsTotal: groups.length,
        sportlotsGroups: groups.filter((g) => g.side === "sportlots").length,
        bscGroups: groups.filter((g) => g.side === "bsc").length,
        brandsTruncated: brandsTruncated.length,
        truncated,
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
          : ""),
      brandsScanned,
      rowsScanned,
      truncated,
      ...(!isDone && cursor !== null ? { continueCursor: cursor } : {}),
      brandsTruncated,
      groupsTotal: groups.length,
      groups: out,
    };
  },
});
