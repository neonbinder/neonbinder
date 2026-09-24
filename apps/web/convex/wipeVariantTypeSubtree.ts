/**
 * NEO-304 — wipe ONE variant type's subtree: every insert and parallel under
 * it, every card on those rows, and everything that points at them.
 *
 * A deliberate, one-off, operator-run exception to "sets are fixed, never
 * deleted" (Jason, 2026-09-24). The NEO-300 duplicate bug left one set's
 * Insert subtree holding good and bad rows mixed together, several hundred of
 * them, and sorting them by hand costs more than re-syncing and regrouping.
 * So the whole subtree goes, INCLUDING rows with holdings, and a re-sync
 * builds it again. There is no UI and there must never be one: this is a
 * scripted admin task in the NEO-214 shape.
 *
 * ## What it keeps
 *
 * The VARIANT TYPE ROW itself stays, with its `platformData` links, labels,
 * facets and metadata untouched: that is what the re-sync attaches the new
 * inserts to. Only its `children` cache is cleared. Cards sitting directly on
 * the variant type row (a Base variant type carries its checklist there) are
 * not part of the subtree below it and are left alone; the dry run says so.
 *
 * Nothing outside the subtree is written, with two deliberate exceptions:
 * the variant type's `children` cache, and the `selectorSyncStatus` rows
 * keyed ON the variant type. Those describe its child columns, the rows
 * being wiped, so their notices would otherwise name rows that no longer
 * exist. Sibling variant types, the set and everything above it, players,
 * teams and leagues are never read for writing.
 *
 * ## The reference graph (from convex/schema.ts)
 *
 * `SUBTREE_REFERENCE_GRAPH` below lists every table that can hold an id this
 * wipe deletes, and what happens to it. `wipeVariantTypeSubtree.test.ts`
 * re-derives that list from schema.ts on every run, so a table added later
 * that points at a selector row, a card or a staged review fails the suite
 * until it is handled here.
 *
 * NB has NO inventory, listing, sales or print tables yet (`labelPurchases`
 * carries no card link). The only holdings beyond the checklist itself are
 * cross-listings, staged checklist reviews and card scans an operator
 * uploaded (`cardChecklist.imageUrls`), and the dry run lists every row that
 * carries one.
 *
 * ## Operator commands
 *
 *   # 0. find the variant type id
 *   npx convex run --prod wipeVariantTypeSubtree:locate \
 *     '{"sport":"Baseball","year":"2026","brand":"Bowman","set":"Bowman"}'
 *
 *   # 1. dry run (the default): writes nothing, needs no arming
 *   npx convex run --prod wipeVariantTypeSubtree:run '{"variantTypeId":"<id>"}'
 *   #    the same with one line per row, for the record
 *   npx convex run --prod wipeVariantTypeSubtree:run \
 *     '{"variantTypeId":"<id>","detail":true}'
 *
 *   # 2. arm, confirm the target, run until "complete": true, disarm
 *   npx convex env set --prod ALLOW_WIPE_VARIANT_TYPE_SUBTREE true
 *   npx convex run --prod wipeVariantTypeSubtree:run \
 *     '{"variantTypeId":"<id>","dryRun":false,"confirm":"<confirmPhrase from the dry run>"}'
 *   npx convex env remove --prod ALLOW_WIPE_VARIANT_TYPE_SUBTREE
 *
 * No `--identity`: it hides internal functions from `convex run` (NEO-214),
 * and the deploy credential is the auth.
 *
 * ## The gate
 *
 * Two independent arms, the NEO-214 pair: the deployment flag
 * `ALLOW_WIPE_VARIANT_TYPE_SUBTREE` (`true` or `1`), its own name so a
 * deployment armed for another task is not armed for this one, and a typed
 * `confirm` that must equal `wipe <variant type name> under <set path>`
 * exactly. The phrase names the target, so a right command pointed at the
 * wrong id refuses. It is an argument, not a prompt, so a `!` run with no TTY
 * works. Both are re-asserted inside every mutation that deletes, so an
 * internal caller that skips `run` gets the same refusal, and every node id
 * a mutation is handed is re-checked to sit under the variant type.
 *
 * ## Budget, order and replay
 *
 * `run` is an action looping bounded internal mutations, the
 * `resetSetBuilderDataFromCli` shape. Each mutation stays under
 * `OP_BUDGET` system operations (~900 comfortable, ~1,800 straining,
 * `CARDS_PER_COMMIT_CHUNK`'s calibration) and commits on its own. Nodes go
 * deepest first; within a node its cards go first (with their
 * cross-listings, and their variation children in the same transaction),
 * then the rows keyed on it, then the node, and only once it is empty; the
 * node's parent loses its child-column sync notices in that same
 * transaction, because those name the node. Each
 * transaction therefore leaves nothing dangling, so a run stopped anywhere is
 * a consistent state. A call stops once it passes `TIME_BUDGET_MS` and
 * returns `complete: false`; re-run the same command until it says `true`.
 * Every call re-walks the subtree from the variant type, so a replay after
 * any partial run finishes cleanly.
 *
 * Every deleted id is logged as a structured JSON line
 * (`msg: "wipe_variant_type_subtree_deleted"`), the `deleteSelectorOption`
 * mechanism. There is no actor on it: a CLI run has no identity, and the
 * deploy credential is the actor.
 */

import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { selectorOptionLevelValidator } from "./schema";
import { selectorValueKey } from "./selectorSyncMatch";

// ───────────────────────────────────────────────────────────────────────────
// The reference graph
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every table holding a field that can carry an id this wipe deletes, and
 * what the wipe does about it. Kept as data so the test can hold it against
 * schema.ts.
 */
export const SUBTREE_REFERENCE_GRAPH = {
  selectorOptions: {
    fields: ["parentId", "children[]"],
    handling:
      "subtree rows deleted deepest first; a parent's children cache is filtered as each child goes; the variant type's is cleared",
  },
  selectorSyncStatus: {
    fields: ["parentId", "unlinked[].id"],
    handling:
      "rows keyed on a subtree row, or on the variant type (its child columns), are deleted; a parent's go with its first child, because unlinked[].id names the children under that key",
  },
  cardChecklist: {
    fields: ["selectorOptionId", "variationOfCardId"],
    handling:
      "cards on subtree rows deleted; a card's variation children go in the same transaction; a child outside the subtree refuses the page",
  },
  cardCrossListings: {
    fields: ["cardChecklistId", "selectorOptionId"],
    handling:
      "both directions deleted: a subtree card's junctions, and junctions listing an outside card into a subtree row (the outside card stays)",
  },
  entityReviewQueue: {
    fields: [
      "selectorOptionId",
      "sportId",
      "source.playerRowId",
      "source.teamRowId",
    ],
    handling:
      "rows keyed on a subtree row deleted, each row's source dependents (same batch, same row) first; sportId is sport-level",
  },
  entityReviewSkips: {
    fields: ["selectorOptionId"],
    handling: "rows keyed on a subtree row deleted",
  },
  checklistCandidates: {
    fields: ["selectorOptionId"],
    handling: "rows keyed on a subtree row deleted",
  },
  players: {
    fields: ["sportId"],
    handling: "sport-level only; a subtree row is never a sport. Untouched",
  },
  playerAliases: {
    fields: ["sportId"],
    handling: "sport-level only. Untouched",
  },
  teams: {
    fields: ["sportId"],
    handling: "sport-level only. Untouched",
  },
  teamAliases: {
    fields: ["sportId"],
    handling: "sport-level only. Untouched",
  },
  leagues: {
    fields: ["sportId"],
    handling: "sport-level only. Untouched",
  },
  franchises: {
    fields: ["sportId"],
    handling: "sport-level only. Untouched",
  },
} as const;

/** The tables this wipe deletes rows from. */
export const WIPED_TABLES = [
  "selectorOptions",
  "cardChecklist",
  "cardCrossListings",
  "entityReviewQueue",
  "checklistCandidates",
  "entityReviewSkips",
  "selectorSyncStatus",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

/** The deployment-level arm. Its own name, per NEO-214 §6. */
export const ENV_FLAG = "ALLOW_WIPE_VARIANT_TYPE_SUBTREE";

/** Refuse, rather than half-walk, a subtree bigger than this. */
const MAX_SUBTREE_NODES = 5000;
/** variantType → insert → parallel is depth 2; anything past this is a cycle. */
const MAX_DEPTH = 8;
/** Parents per `listChildren` call. */
const LIST_CHILDREN_GROUP = 100;

/**
 * System operations one deleting mutation may spend before it ends its page.
 * A card costs ~3 (variation-children read, cross-listing read, delete) plus
 * one per junction; ~700 leaves room under the ~900 comfortable line for the
 * fixed reads (target, ancestors, membership).
 */
const OP_BUDGET = 700;
/** Cards read per page. 150 cards × ~3 ops ≈ 450; the op budget ends it early otherwise. */
const CARD_PAGE_DEFAULT = 150;
/** Rows keyed on a node deleted per call, across its tables. */
const REF_PAGE_DEFAULT = 400;
/** Nodes checked-and-deleted per call: ~17 ops each. */
const NODE_GROUP_DEFAULT = 40;

/** A call stops after the first batch that lands past this; see the header. */
const TIME_BUDGET_MS = 150_000;

/** Nodes per `surveyNodeRefs` call, and rows each table is probed for. */
const SURVEY_NODE_GROUP = 10;
const SURVEY_REF_PROBE = 100;
/** Rows per page when a probe saturates and the count has to be exact. */
const SURVEY_COUNT_PAGE = 1000;
/** Cards per survey page: 2 reads each. */
const SURVEY_CARD_PAGE = 200;

/** Ids per log line, so no line approaches the log size cap. */
const LOG_IDS_PER_LINE = 100;
/** The display value is capped in logs, as `deleteSelectorOption` does. */
const LOG_VALUE_MAX = 80;

const ALL_LEVELS = [
  "sport",
  "year",
  "manufacturer",
  "setName",
  "variantType",
  "insert",
  "parallel",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "true" || value === "1";
}

const NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed for the subtree wipe. Set ` +
  `${ENV_FLAG}=true on it (npx convex env set ${ENV_FLAG} true, with --prod ` +
  `for production), re-run, and remove it afterwards. Nothing was written.`;

export function confirmPhraseFor(value: string, path: string[]): string {
  return `wipe ${value} under ${path.join(" / ")}`;
}

type DbReader = { get: QueryCtx["db"]["get"] };

type Target = {
  row: Doc<"selectorOptions">;
  /** Ancestor values, sport first, down to the variant type's parent. */
  path: string[];
  confirmPhrase: string;
};

/** The variant type row and its path, or a refusal. */
async function loadTarget(
  db: DbReader,
  variantTypeId: Id<"selectorOptions">,
): Promise<Target> {
  const row = await db.get(variantTypeId);
  if (!row) {
    throw new ConvexError(
      `Refused: no selectorOptions row ${variantTypeId}. Nothing was written.`,
    );
  }
  if (row.level !== "variantType") {
    throw new ConvexError(
      `Refused: ${variantTypeId} is a ${row.level} row, not a variantType. ` +
        `This wipes the subtree under one variant type only. Nothing was written.`,
    );
  }
  const path: string[] = [];
  let parentId = row.parentId;
  for (let hops = 0; parentId !== undefined && hops < MAX_DEPTH; hops += 1) {
    const parent = await db.get(parentId);
    if (!parent) break;
    path.unshift(parent.value);
    parentId = parent.parentId;
  }
  return { row, path, confirmPhrase: confirmPhraseFor(row.value, path) };
}

/**
 * Both arms, asserted next to every delete. `confirm` must equal the phrase
 * for THIS variant type, recomputed from the rows as they stand.
 */
async function assertArmedFor(
  db: DbReader,
  variantTypeId: Id<"selectorOptions">,
  confirm: string,
): Promise<Target> {
  if (!deploymentIsArmed()) throw new ConvexError(NOT_ARMED_MESSAGE);
  const target = await loadTarget(db, variantTypeId);
  if (confirm !== target.confirmPhrase) {
    throw new ConvexError(
      `Refused: confirm does not match. For this variant type it must be ` +
        `exactly "${target.confirmPhrase}". Nothing was written.`,
    );
  }
  return target;
}

/**
 * "Does this row sit under the variant type?", by walking up its parents.
 * The variant type itself is NOT a member: it is kept. Cached per call.
 */
function membershipFor(
  db: DbReader,
  variantTypeId: Id<"selectorOptions">,
): (id: Id<"selectorOptions">) => Promise<boolean> {
  const cache = new Map<string, boolean>();
  return async (id) => {
    if (id === variantTypeId) return false;
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const visited: string[] = [];
    let current: Id<"selectorOptions"> | undefined = id;
    let answer = false;
    for (let hops = 0; current !== undefined && hops < MAX_DEPTH; hops += 1) {
      const known = cache.get(current);
      if (known !== undefined) {
        answer = known;
        break;
      }
      visited.push(current);
      const row: Doc<"selectorOptions"> | null = await db.get(current);
      if (!row || row.parentId === undefined) break;
      if (row.parentId === variantTypeId) {
        answer = true;
        break;
      }
      current = row.parentId;
    }
    for (const seen of visited) cache.set(seen, answer);
    return answer;
  };
}

function truncateForLog(value: string): string {
  return value.length > LOG_VALUE_MAX
    ? `${value.slice(0, LOG_VALUE_MAX)}…`
    : value;
}

function logDeleted(
  variantTypeId: Id<"selectorOptions">,
  table: (typeof WIPED_TABLES)[number],
  entries: Array<string | Record<string, unknown>>,
): void {
  for (let i = 0; i < entries.length; i += LOG_IDS_PER_LINE) {
    console.log(
      JSON.stringify({
        msg: "wipe_variant_type_subtree_deleted",
        variantTypeId,
        table,
        ids: entries.slice(i, i + LOG_IDS_PER_LINE),
      }),
    );
  }
}

function clampPage(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  return Math.max(1, Math.min(Math.floor(requested), fallback));
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// ───────────────────────────────────────────────────────────────────────────
// Validators
// ───────────────────────────────────────────────────────────────────────────

const slotMapValidator = v.record(v.string(), v.string());

const nodeValidator = v.object({
  id: v.id("selectorOptions"),
  level: selectorOptionLevelValidator,
  value: v.string(),
  parentId: v.id("selectorOptions"),
  bsc: slotMapValidator,
  sportlots: slotMapValidator,
});

type NodeInfo = {
  id: Id<"selectorOptions">;
  level: Doc<"selectorOptions">["level"];
  value: string;
  parentId: Id<"selectorOptions">;
  bsc: Record<string, string>;
  sportlots: Record<string, string>;
};

const targetValidator = v.object({
  id: v.id("selectorOptions"),
  value: v.string(),
  path: v.string(),
  confirmPhrase: v.string(),
  isBase: v.boolean(),
  bsc: slotMapValidator,
  sportlots: slotMapValidator,
  /** Cards on the variant type row itself. Not part of the subtree; kept. */
  hasOwnCards: v.boolean(),
  /** `selectorSyncStatus` rows keyed on the variant type (its child columns). */
  statusRows: v.number(),
});

type TargetInfo = {
  id: Id<"selectorOptions">;
  value: string;
  path: string;
  confirmPhrase: string;
  isBase: boolean;
  bsc: Record<string, string>;
  sportlots: Record<string, string>;
  hasOwnCards: boolean;
  statusRows: number;
};

const holdsValidator = v.record(v.string(), v.number());

const rowReportValidator = v.object({
  id: v.id("selectorOptions"),
  level: selectorOptionLevelValidator,
  value: v.string(),
  parentId: v.id("selectorOptions"),
  bsc: slotMapValidator,
  sportlots: slotMapValidator,
  /** Non-zero holdings only. */
  holds: holdsValidator,
});

const lossValidator = v.object({
  id: v.id("selectorOptions"),
  level: selectorOptionLevelValidator,
  value: v.string(),
  holds: holdsValidator,
});

const blockerValidator = v.object({
  cardId: v.id("cardChecklist"),
  childCardId: v.id("cardChecklist"),
  childSelectorOptionId: v.id("selectorOptions"),
});

const tableCountsValidator = v.object({
  selectorOptions: v.object({
    total: v.number(),
    insert: v.number(),
    parallel: v.number(),
    other: v.number(),
  }),
  cardChecklist: v.number(),
  cardCrossListings: v.number(),
  entityReviewQueue: v.number(),
  checklistCandidates: v.number(),
  entityReviewSkips: v.number(),
  selectorSyncStatus: v.number(),
});

type TableCounts = {
  selectorOptions: {
    total: number;
    insert: number;
    parallel: number;
    other: number;
  };
  cardChecklist: number;
  cardCrossListings: number;
  entityReviewQueue: number;
  checklistCandidates: number;
  entityReviewSkips: number;
  selectorSyncStatus: number;
};

function zeroCounts(): TableCounts {
  return {
    selectorOptions: { total: 0, insert: 0, parallel: 0, other: 0 },
    cardChecklist: 0,
    cardCrossListings: 0,
    entityReviewQueue: 0,
    checklistCandidates: 0,
    entityReviewSkips: 0,
    selectorSyncStatus: 0,
  };
}

function countNodeLevel(counts: TableCounts, level: string): void {
  counts.selectorOptions.total += 1;
  if (level === "insert") counts.selectorOptions.insert += 1;
  else if (level === "parallel") counts.selectorOptions.parallel += 1;
  else counts.selectorOptions.other += 1;
}

const NO_INVENTORY_NOTE =
  "NB has no inventory, listing or sales tables yet, so nothing of that kind " +
  "is lost. beyondChecklist lists every row holding more than its own cards: " +
  "cross-listings to or from rows outside this subtree, staged checklist " +
  "reviews, and cards with uploaded scans. Cards on the variant type row " +
  "itself, and the row with its marketplace links, are kept.";

// ───────────────────────────────────────────────────────────────────────────
// Reads
// ───────────────────────────────────────────────────────────────────────────

/**
 * Find a variant type id by its set's path. Values are matched folded
 * (lowercase, trimmed); every match is returned, because a duplicate set or
 * variant type is exactly the kind of damage this tool exists for.
 */
export const locate = internalQuery({
  args: {
    sport: v.string(),
    year: v.string(),
    brand: v.string(),
    set: v.string(),
  },
  returns: v.array(
    v.object({
      setId: v.id("selectorOptions"),
      path: v.string(),
      variantTypes: v.array(
        v.object({
          id: v.id("selectorOptions"),
          value: v.string(),
          isBase: v.boolean(),
          children: v.number(),
          bsc: slotMapValidator,
          sportlots: slotMapValidator,
          confirmPhrase: v.string(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const childrenMatching = async (
      level: (typeof ALL_LEVELS)[number],
      parentId: Id<"selectorOptions"> | undefined,
      name: string,
    ): Promise<Doc<"selectorOptions">[]> => {
      const key = selectorValueKey(name);
      const rows = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", level).eq("parentId", parentId),
        )
        .take(MAX_SUBTREE_NODES);
      return rows.filter((row) => selectorValueKey(row.value) === key);
    };

    const sports = (
      await ctx.db
        .query("selectorOptions")
        .withIndex("by_level", (q) => q.eq("level", "sport"))
        .take(200)
    ).filter((row) => selectorValueKey(row.value) === selectorValueKey(args.sport));

    const out = [];
    for (const sport of sports) {
      for (const year of await childrenMatching("year", sport._id, args.year)) {
        for (const brand of await childrenMatching(
          "manufacturer",
          year._id,
          args.brand,
        )) {
          for (const set of await childrenMatching(
            "setName",
            brand._id,
            args.set,
          )) {
            const path = [sport.value, year.value, brand.value, set.value];
            const variantTypes = await ctx.db
              .query("selectorOptions")
              .withIndex("by_level_and_parent", (q) =>
                q.eq("level", "variantType").eq("parentId", set._id),
              )
              .take(200);
            const described = [];
            for (const vt of variantTypes) {
              const children = await ctx.db
                .query("selectorOptions")
                .withIndex("by_parent", (q) => q.eq("parentId", vt._id))
                .take(MAX_SUBTREE_NODES);
              described.push({
                id: vt._id,
                value: vt.value,
                isBase: vt.metadata?.isBase === true,
                children: children.length,
                bsc: vt.platformData.bsc ?? {},
                sportlots: vt.platformData.sportlots ?? {},
                confirmPhrase: confirmPhraseFor(vt.value, path),
              });
            }
            out.push({
              setId: set._id,
              path: path.join(" / "),
              variantTypes: described,
            });
          }
        }
      }
    }
    return out;
  },
});

export const readTarget = internalQuery({
  args: { variantTypeId: v.id("selectorOptions") },
  returns: targetValidator,
  handler: async (ctx, args): Promise<TargetInfo> => {
    const target = await loadTarget(ctx.db, args.variantTypeId);
    const ownCard = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.variantTypeId),
      )
      .first();
    let statusRows = 0;
    for (const level of ALL_LEVELS) {
      const rows = await ctx.db
        .query("selectorSyncStatus")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", level).eq("parentId", args.variantTypeId),
        )
        .take(SURVEY_REF_PROBE);
      statusRows += rows.length;
    }
    return {
      id: target.row._id,
      value: target.row.value,
      path: target.path.join(" / "),
      confirmPhrase: target.confirmPhrase,
      isBase: target.row.metadata?.isBase === true,
      bsc: target.row.platformData.bsc ?? {},
      sportlots: target.row.platformData.sportlots ?? {},
      hasOwnCards: ownCard !== null,
      statusRows,
    };
  },
});

/** One level of the walk: every child of each parent. */
export const listChildren = internalQuery({
  args: { parentIds: v.array(v.id("selectorOptions")) },
  returns: v.array(nodeValidator),
  handler: async (ctx, args): Promise<NodeInfo[]> => {
    if (args.parentIds.length > LIST_CHILDREN_GROUP) {
      throw new ConvexError(
        `listChildren takes at most ${LIST_CHILDREN_GROUP} parents per call.`,
      );
    }
    const out: NodeInfo[] = [];
    for (const parentId of args.parentIds) {
      const rows = await ctx.db
        .query("selectorOptions")
        .withIndex("by_parent", (q) => q.eq("parentId", parentId))
        .take(MAX_SUBTREE_NODES + 1);
      if (rows.length > MAX_SUBTREE_NODES) {
        throw new ConvexError(
          `Refused: a row under this variant type has more than ` +
            `${MAX_SUBTREE_NODES} children. Nothing was written.`,
        );
      }
      for (const row of rows) {
        out.push({
          id: row._id,
          level: row.level,
          value: row.value,
          parentId,
          bsc: row.platformData.bsc ?? {},
          sportlots: row.platformData.sportlots ?? {},
        });
      }
    }
    return out;
  },
});

const refTableValidator = v.union(
  v.literal("entityReviewQueue"),
  v.literal("checklistCandidates"),
  v.literal("entityReviewSkips"),
  v.literal("cardCrossListings"),
);
type RefTable =
  | "entityReviewQueue"
  | "checklistCandidates"
  | "entityReviewSkips"
  | "cardCrossListings";

const crossInValidator = v.object({
  id: v.id("cardCrossListings"),
  cardId: v.id("cardChecklist"),
});

/**
 * The rows keyed on each node, probed. A probe that saturates says so, and
 * the action counts that (node, table) exactly with `countRefsPage`.
 */
export const surveyNodeRefs = internalQuery({
  args: { nodeIds: v.array(v.id("selectorOptions")) },
  returns: v.array(
    v.object({
      nodeId: v.id("selectorOptions"),
      entityReviewQueue: v.number(),
      checklistCandidates: v.number(),
      entityReviewSkips: v.number(),
      crossIn: v.array(crossInValidator),
      selectorSyncStatus: v.number(),
      saturated: v.array(refTableValidator),
    }),
  ),
  handler: async (ctx, args) => {
    if (args.nodeIds.length > SURVEY_NODE_GROUP) {
      throw new ConvexError(
        `surveyNodeRefs takes at most ${SURVEY_NODE_GROUP} nodes per call.`,
      );
    }
    const limit = SURVEY_REF_PROBE + 1;
    const out = [];
    for (const nodeId of args.nodeIds) {
      const saturated: RefTable[] = [];
      const queue = await ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", nodeId))
        .take(limit);
      if (queue.length === limit) saturated.push("entityReviewQueue");
      const candidates = await ctx.db
        .query("checklistCandidates")
        .withIndex("by_selector_option_and_user", (q) =>
          q.eq("selectorOptionId", nodeId),
        )
        .take(limit);
      if (candidates.length === limit) saturated.push("checklistCandidates");
      const skips = await ctx.db
        .query("entityReviewSkips")
        .withIndex("by_selector_option_and_kind_and_name", (q) =>
          q.eq("selectorOptionId", nodeId),
        )
        .take(limit);
      if (skips.length === limit) saturated.push("entityReviewSkips");
      const crossIn = await ctx.db
        .query("cardCrossListings")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", nodeId))
        .take(limit);
      if (crossIn.length === limit) saturated.push("cardCrossListings");
      let statuses = 0;
      for (const level of ALL_LEVELS) {
        const rows = await ctx.db
          .query("selectorSyncStatus")
          .withIndex("by_level_and_parent", (q) =>
            q.eq("level", level).eq("parentId", nodeId),
          )
          .take(SURVEY_REF_PROBE);
        statuses += rows.length;
      }
      out.push({
        nodeId,
        entityReviewQueue: queue.length,
        checklistCandidates: candidates.length,
        entityReviewSkips: skips.length,
        crossIn: crossIn.map((link) => ({
          id: link._id,
          cardId: link.cardChecklistId,
        })),
        selectorSyncStatus: statuses,
        saturated,
      });
    }
    return out;
  },
});

/** One exact-count page of one table's rows keyed on one node. */
export const countRefsPage = internalQuery({
  args: {
    nodeId: v.id("selectorOptions"),
    table: refTableValidator,
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    count: v.number(),
    crossIn: v.array(crossInValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const opts = { cursor: args.cursor, numItems: SURVEY_COUNT_PAGE };
    const nodeId = args.nodeId;
    switch (args.table) {
      case "entityReviewQueue": {
        const page = await ctx.db
          .query("entityReviewQueue")
          .withIndex("by_selector_option", (q) =>
            q.eq("selectorOptionId", nodeId),
          )
          .paginate(opts);
        return {
          count: page.page.length,
          crossIn: [],
          isDone: page.isDone,
          continueCursor: page.continueCursor,
        };
      }
      case "checklistCandidates": {
        const page = await ctx.db
          .query("checklistCandidates")
          .withIndex("by_selector_option_and_user", (q) =>
            q.eq("selectorOptionId", nodeId),
          )
          .paginate(opts);
        return {
          count: page.page.length,
          crossIn: [],
          isDone: page.isDone,
          continueCursor: page.continueCursor,
        };
      }
      case "entityReviewSkips": {
        const page = await ctx.db
          .query("entityReviewSkips")
          .withIndex("by_selector_option_and_kind_and_name", (q) =>
            q.eq("selectorOptionId", nodeId),
          )
          .paginate(opts);
        return {
          count: page.page.length,
          crossIn: [],
          isDone: page.isDone,
          continueCursor: page.continueCursor,
        };
      }
      case "cardCrossListings": {
        const page = await ctx.db
          .query("cardCrossListings")
          .withIndex("by_selector_option", (q) =>
            q.eq("selectorOptionId", nodeId),
          )
          .paginate(opts);
        return {
          count: page.page.length,
          crossIn: page.page.map((link) => ({
            id: link._id,
            cardId: link.cardChecklistId,
          })),
          isDone: page.isDone,
          continueCursor: page.continueCursor,
        };
      }
    }
  },
});

/**
 * One page of a node's cards, with what hangs off each: its cross-listings
 * (with where they point) and any variation child living on another row.
 */
export const surveyCardsPage = internalQuery({
  args: {
    nodeId: v.id("selectorOptions"),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    cardIds: v.array(v.id("cardChecklist")),
    withImages: v.number(),
    crossOut: v.array(
      v.object({
        id: v.id("cardCrossListings"),
        guestId: v.id("selectorOptions"),
      }),
    ),
    childrenElsewhere: v.array(blockerValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.nodeId),
      )
      .paginate({ cursor: args.cursor, numItems: SURVEY_CARD_PAGE });
    let withImages = 0;
    const crossOut: Array<{
      id: Id<"cardCrossListings">;
      guestId: Id<"selectorOptions">;
    }> = [];
    const childrenElsewhere: Array<{
      cardId: Id<"cardChecklist">;
      childCardId: Id<"cardChecklist">;
      childSelectorOptionId: Id<"selectorOptions">;
    }> = [];
    for (const card of page.page) {
      if (card.imageUrls?.front || card.imageUrls?.back) withImages += 1;
      const links = await ctx.db
        .query("cardCrossListings")
        .withIndex("by_card", (q) => q.eq("cardChecklistId", card._id))
        .collect();
      for (const link of links) {
        crossOut.push({ id: link._id, guestId: link.selectorOptionId });
      }
      const children = await ctx.db
        .query("cardChecklist")
        .withIndex("by_variation_parent", (q) =>
          q.eq("variationOfCardId", card._id),
        )
        .collect();
      for (const child of children) {
        if (child.selectorOptionId !== args.nodeId) {
          childrenElsewhere.push({
            cardId: card._id,
            childCardId: child._id,
            childSelectorOptionId: child.selectorOptionId,
          });
        }
      }
    }
    return {
      cardIds: page.page.map((card) => card._id),
      withImages,
      crossOut,
      childrenElsewhere,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Writes: every one re-asserts both arms and subtree membership
// ───────────────────────────────────────────────────────────────────────────

const armedArgs = {
  variantTypeId: v.id("selectorOptions"),
  confirm: v.string(),
};

async function assertNodeInSubtree(
  isMember: (id: Id<"selectorOptions">) => Promise<boolean>,
  nodeId: Id<"selectorOptions">,
): Promise<void> {
  if (!(await isMember(nodeId))) {
    throw new ConvexError(
      `Refused: ${nodeId} is not under this variant type. Nothing was written.`,
    );
  }
}

/**
 * One page of a node's cards, deleted with their cross-listings. A card's
 * variation children go in the same transaction, so no committed state has a
 * `variationOfCardId` pointing at nothing. A child on a row OUTSIDE the
 * subtree refuses the whole page: deleting its parent would leave it
 * dangling, and it is not this wipe's to touch.
 */
export const wipeCardsPage = internalMutation({
  args: {
    ...armedArgs,
    nodeId: v.id("selectorOptions"),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    cardChecklist: v.number(),
    cardCrossListings: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await assertArmedFor(ctx.db, args.variantTypeId, args.confirm);
    const isMember = membershipFor(ctx.db, args.variantTypeId);
    await assertNodeInSubtree(isMember, args.nodeId);

    const limit = clampPage(args.limit, CARD_PAGE_DEFAULT);
    let ops = 10;
    const cards = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.nodeId),
      )
      .take(limit);
    ops += 1;

    const deleted = new Set<string>();
    const deletedCards: string[] = [];
    const deletedLinks: string[] = [];
    const dropCard = async (card: Doc<"cardChecklist">): Promise<void> => {
      const links = await ctx.db
        .query("cardCrossListings")
        .withIndex("by_card", (q) => q.eq("cardChecklistId", card._id))
        .collect();
      ops += 1;
      for (const link of links) {
        await ctx.db.delete(link._id);
        deletedLinks.push(link._id);
        ops += 1;
      }
      await ctx.db.delete(card._id);
      deleted.add(card._id);
      deletedCards.push(card._id);
      ops += 1;
    };

    let stoppedEarly = false;
    for (const card of cards) {
      if (deleted.has(card._id)) continue;
      if (ops >= OP_BUDGET) {
        stoppedEarly = true;
        break;
      }
      const children = await ctx.db
        .query("cardChecklist")
        .withIndex("by_variation_parent", (q) =>
          q.eq("variationOfCardId", card._id),
        )
        .collect();
      ops += 1;
      for (const child of children) {
        if (deleted.has(child._id)) continue;
        if (
          child.selectorOptionId !== args.nodeId &&
          !(await isMember(child.selectorOptionId))
        ) {
          throw new ConvexError(
            `Refused: card ${card._id} has a variation (${child._id}) on ` +
              `row ${child.selectorOptionId}, outside this variant type. ` +
              `Re-parent or clear that variation first. This page wrote nothing.`,
          );
        }
        await dropCard(child);
      }
      await dropCard(card);
    }

    logDeleted(args.variantTypeId, "cardCrossListings", deletedLinks);
    logDeleted(args.variantTypeId, "cardChecklist", deletedCards);
    return {
      cardChecklist: deletedCards.length,
      cardCrossListings: deletedLinks.length,
      hasMore: stoppedEarly || cards.length === limit,
    };
  },
});

/**
 * One page of the rows KEYED ON a node: staged reviews, candidate cards,
 * skip rulings, cross-listings of outside cards into it, and its child
 * columns' sync status.
 */
export const wipeNodeRefsPage = internalMutation({
  args: {
    ...armedArgs,
    nodeId: v.id("selectorOptions"),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    entityReviewQueue: v.number(),
    checklistCandidates: v.number(),
    entityReviewSkips: v.number(),
    cardCrossListings: v.number(),
    selectorSyncStatus: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await assertArmedFor(ctx.db, args.variantTypeId, args.confirm);
    const isMember = membershipFor(ctx.db, args.variantTypeId);
    await assertNodeInSubtree(isMember, args.nodeId);

    const nodeId = args.nodeId;
    // Two bounds: rows deleted (the caller's page size) and system operations
    // (`OP_BUDGET`). A staged review row costs ~3 (its two dependent reads and
    // its delete), everything else 1.
    let rowsLeft = clampPage(args.limit, REF_PAGE_DEFAULT);
    let ops = 10;
    let hasMore = false;
    const spent = () => rowsLeft <= 0 || ops >= OP_BUDGET;

    // A staged row can be the `source` of others in its batch (a player's
    // career team, a team's league). Those go first, in this transaction, so
    // no page boundary leaves a `source` pointing at a deleted row.
    const queueDeleted: Doc<"entityReviewQueue">[] = [];
    const queueGone = new Set<string>();
    const dropQueueRow = async (
      row: Doc<"entityReviewQueue">,
      depth: number,
    ): Promise<void> => {
      if (queueGone.has(row._id)) return;
      const dependents = [
        ...(await ctx.db
          .query("entityReviewQueue")
          .withIndex("by_source_player", (q) =>
            q.eq("source.playerRowId", row._id),
          )
          .collect()),
        ...(await ctx.db
          .query("entityReviewQueue")
          .withIndex("by_source_team", (q) => q.eq("source.teamRowId", row._id))
          .collect()),
      ];
      ops += 2;
      for (const dependent of dependents) {
        if (
          dependent.selectorOptionId !== nodeId &&
          !(await isMember(dependent.selectorOptionId))
        ) {
          throw new ConvexError(
            `Refused: staged review row ${dependent._id} depends on ` +
              `${row._id} but is keyed outside this variant type. This page ` +
              `wrote nothing.`,
          );
        }
        if (depth < MAX_DEPTH) await dropQueueRow(dependent, depth + 1);
      }
      await ctx.db.delete(row._id);
      queueGone.add(row._id);
      queueDeleted.push(row);
      ops += 1;
      rowsLeft -= 1;
    };

    const queueLimit = Math.max(
      1,
      Math.min(rowsLeft, Math.floor((OP_BUDGET - ops) / 3)),
    );
    const queue = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", nodeId))
      .take(queueLimit);
    ops += 1;
    if (queue.length === queueLimit) hasMore = true;
    for (const row of queue) {
      if (queueGone.has(row._id)) continue;
      // The first row always goes, so a page can never end where it started.
      if (queueDeleted.length > 0 && spent()) {
        hasMore = true;
        break;
      }
      await dropQueueRow(row, 0);
    }

    /** Fetch at most what both bounds allow, delete it, and count it. */
    const drain = async <R extends { _id: string }>(
      fetch: (n: number) => Promise<R[]>,
      remove: (id: R["_id"]) => Promise<void>,
    ): Promise<R[]> => {
      if (spent()) {
        hasMore = true;
        return [];
      }
      const n = Math.max(1, Math.min(rowsLeft, OP_BUDGET - ops - 1));
      const rows = await fetch(n);
      ops += 1;
      for (const row of rows) {
        await remove(row._id);
        ops += 1;
        rowsLeft -= 1;
      }
      if (rows.length === n) hasMore = true;
      return rows;
    };

    const candidates = await drain(
      (n) =>
        ctx.db
          .query("checklistCandidates")
          .withIndex("by_selector_option_and_user", (q) =>
            q.eq("selectorOptionId", nodeId),
          )
          .take(n),
      (id) => ctx.db.delete(id),
    );
    const skips = await drain(
      (n) =>
        ctx.db
          .query("entityReviewSkips")
          .withIndex("by_selector_option_and_kind_and_name", (q) =>
            q.eq("selectorOptionId", nodeId),
          )
          .take(n),
      (id) => ctx.db.delete(id),
    );
    const crossIn = await drain(
      (n) =>
        ctx.db
          .query("cardCrossListings")
          .withIndex("by_selector_option", (q) =>
            q.eq("selectorOptionId", nodeId),
          )
          .take(n),
      (id) => ctx.db.delete(id),
    );
    const statuses: Doc<"selectorSyncStatus">[] = [];
    for (const level of ALL_LEVELS) {
      statuses.push(
        ...(await drain(
          (n) =>
            ctx.db
              .query("selectorSyncStatus")
              .withIndex("by_level_and_parent", (q) =>
                q.eq("level", level).eq("parentId", nodeId),
              )
              .take(n),
          (id) => ctx.db.delete(id),
        )),
      );
    }

    const ids = (rows: Array<{ _id: string }>) => rows.map((row) => row._id);
    logDeleted(args.variantTypeId, "entityReviewQueue", ids(queueDeleted));
    logDeleted(args.variantTypeId, "checklistCandidates", ids(candidates));
    logDeleted(args.variantTypeId, "entityReviewSkips", ids(skips));
    logDeleted(args.variantTypeId, "cardCrossListings", ids(crossIn));
    logDeleted(args.variantTypeId, "selectorSyncStatus", ids(statuses));

    return {
      entityReviewQueue: queueDeleted.length,
      checklistCandidates: candidates.length,
      entityReviewSkips: skips.length,
      cardCrossListings: crossIn.length,
      selectorSyncStatus: statuses.length,
      hasMore,
    };
  },
});

/**
 * Delete each node that is now EMPTY, checked in this transaction: no child
 * rows, no cards, nothing keyed on it. A node that is not (a sync landed a
 * card mid-run) is skipped and reported, and the next run takes it. Each
 * deleted node's id is filtered out of its parent's `children` cache.
 */
export const deleteEmptyNodes = internalMutation({
  args: {
    ...armedArgs,
    nodeIds: v.array(v.id("selectorOptions")),
  },
  returns: v.object({
    insert: v.number(),
    parallel: v.number(),
    other: v.number(),
    selectorSyncStatus: v.number(),
    notEmpty: v.array(v.id("selectorOptions")),
  }),
  handler: async (ctx, args) => {
    await assertArmedFor(ctx.db, args.variantTypeId, args.confirm);
    if (args.nodeIds.length > NODE_GROUP_DEFAULT) {
      throw new ConvexError(
        `deleteEmptyNodes takes at most ${NODE_GROUP_DEFAULT} nodes per call.`,
      );
    }
    const isMember = membershipFor(ctx.db, args.variantTypeId);
    const counts = { insert: 0, parallel: 0, other: 0 };
    const notEmpty: Id<"selectorOptions">[] = [];
    const deletedIds = new Set<string>();
    const deletedRows: Array<Record<string, unknown>> = [];
    const parents = new Set<Id<"selectorOptions">>();

    for (const nodeId of args.nodeIds) {
      const row = await ctx.db.get(nodeId);
      if (!row) continue; // already gone: a replay
      await assertNodeInSubtree(isMember, nodeId);

      const holds =
        (await ctx.db
          .query("selectorOptions")
          .withIndex("by_parent", (q) => q.eq("parentId", nodeId))
          .first()) ??
        (await ctx.db
          .query("cardChecklist")
          .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", nodeId))
          .first()) ??
        (await ctx.db
          .query("entityReviewQueue")
          .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", nodeId))
          .first()) ??
        (await ctx.db
          .query("checklistCandidates")
          .withIndex("by_selector_option_and_user", (q) =>
            q.eq("selectorOptionId", nodeId),
          )
          .first()) ??
        (await ctx.db
          .query("entityReviewSkips")
          .withIndex("by_selector_option_and_kind_and_name", (q) =>
            q.eq("selectorOptionId", nodeId),
          )
          .first()) ??
        (await ctx.db
          .query("cardCrossListings")
          .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", nodeId))
          .first());
      let statusHeld = false;
      if (holds === null) {
        for (const level of ALL_LEVELS) {
          const status = await ctx.db
            .query("selectorSyncStatus")
            .withIndex("by_level_and_parent", (q) =>
              q.eq("level", level).eq("parentId", nodeId),
            )
            .first();
          if (status) {
            statusHeld = true;
            break;
          }
        }
      }
      if (holds !== null || statusHeld) {
        notEmpty.push(nodeId);
        continue;
      }

      await ctx.db.delete(nodeId);
      deletedIds.add(nodeId);
      deletedRows.push({
        id: nodeId,
        level: row.level,
        value: truncateForLog(row.value),
      });
      if (row.level === "insert") counts.insert += 1;
      else if (row.level === "parallel") counts.parallel += 1;
      else counts.other += 1;
      if (row.parentId) parents.add(row.parentId);
    }

    // Each parent's own tidy-up, in the same transaction as its children
    // going. Its child columns' sync status names those children
    // (`unlinked[].id`), and the column is being emptied, so the notice goes
    // with the first child rather than dangling until the parent's turn. The
    // parent is a subtree row or the variant type; both lose these anyway.
    // Then its `children` cache, write-if-changed (NEO-85): a byte-identical
    // patch still invalidates every query that read the parent.
    const statusIds: string[] = [];
    for (const parentId of parents) {
      if (deletedIds.has(parentId)) continue;
      for (const level of ALL_LEVELS) {
        const statuses = await ctx.db
          .query("selectorSyncStatus")
          .withIndex("by_level_and_parent", (q) =>
            q.eq("level", level).eq("parentId", parentId),
          )
          .take(SURVEY_REF_PROBE);
        for (const status of statuses) {
          await ctx.db.delete(status._id);
          statusIds.push(status._id);
        }
      }
      const parent = await ctx.db.get(parentId);
      if (!parent) continue;
      const current = parent.children ?? [];
      const next = current.filter((id) => !deletedIds.has(id));
      if (!sameIds(current, next)) {
        await ctx.db.patch(parentId, { children: next });
      }
    }

    logDeleted(args.variantTypeId, "selectorOptions", deletedRows);
    logDeleted(args.variantTypeId, "selectorSyncStatus", statusIds);
    return { ...counts, selectorSyncStatus: statusIds.length, notEmpty };
  },
});

/**
 * The variant type's own tidy-up, once its subtree is gone: its child
 * columns' sync status, and its `children` cache. Its links, labels and
 * metadata are not written.
 */
export const finalizeVariantType = internalMutation({
  args: armedArgs,
  returns: v.object({
    selectorSyncStatus: v.number(),
    childrenRemaining: v.number(),
    childrenCacheCleared: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const target = await assertArmedFor(
      ctx.db,
      args.variantTypeId,
      args.confirm,
    );
    const statuses: Doc<"selectorSyncStatus">[] = [];
    for (const level of ALL_LEVELS) {
      statuses.push(
        ...(await ctx.db
          .query("selectorSyncStatus")
          .withIndex("by_level_and_parent", (q) =>
            q.eq("level", level).eq("parentId", args.variantTypeId),
          )
          .take(SURVEY_REF_PROBE)),
      );
    }
    for (const row of statuses) await ctx.db.delete(row._id);
    logDeleted(
      args.variantTypeId,
      "selectorSyncStatus",
      statuses.map((row) => row._id),
    );

    const remaining = await ctx.db
      .query("selectorOptions")
      .withIndex("by_parent", (q) => q.eq("parentId", args.variantTypeId))
      .take(MAX_SUBTREE_NODES);
    const remainingIds = new Set<string>(remaining.map((row) => row._id));
    const current = target.row.children ?? [];
    const next = current.filter((id) => remainingIds.has(id));
    const changed = !sameIds(current, next);
    if (changed) {
      await ctx.db.patch(args.variantTypeId, { children: next });
    }
    return {
      selectorSyncStatus: statuses.length,
      childrenRemaining: remaining.length,
      childrenCacheCleared: changed && next.length === 0,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// The entry point
// ───────────────────────────────────────────────────────────────────────────

type WalkedNode = NodeInfo & { depth: number };

async function walkSubtree(
  ctx: ActionCtx,
  variantTypeId: Id<"selectorOptions">,
): Promise<WalkedNode[]> {
  const nodes: WalkedNode[] = [];
  const seen = new Set<string>([variantTypeId]);
  let frontier: Id<"selectorOptions">[] = [variantTypeId];
  for (let depth = 1; frontier.length > 0; depth += 1) {
    if (depth > MAX_DEPTH) {
      throw new ConvexError(
        `Refused: the subtree is deeper than ${MAX_DEPTH} levels. Nothing was written.`,
      );
    }
    const next: Id<"selectorOptions">[] = [];
    for (let i = 0; i < frontier.length; i += LIST_CHILDREN_GROUP) {
      const children: NodeInfo[] = await ctx.runQuery(
        internal.wipeVariantTypeSubtree.listChildren,
        { parentIds: frontier.slice(i, i + LIST_CHILDREN_GROUP) },
      );
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        nodes.push({ ...child, depth });
        next.push(child.id);
      }
      if (nodes.length > MAX_SUBTREE_NODES) {
        throw new ConvexError(
          `Refused: more than ${MAX_SUBTREE_NODES} rows under this variant ` +
            `type. Nothing was written.`,
        );
      }
    }
    frontier = next;
  }
  return nodes;
}

type Holds = {
  children: number;
  cards: number;
  cardsWithImages: number;
  crossListingsIn: number;
  crossListingsOut: number;
  crossListingsInternal: number;
  reviewQueue: number;
  candidates: number;
  skips: number;
  syncStatus: number;
  externalVariationChildren: number;
};

function emptyHolds(): Holds {
  return {
    children: 0,
    cards: 0,
    cardsWithImages: 0,
    crossListingsIn: 0,
    crossListingsOut: 0,
    crossListingsInternal: 0,
    reviewQueue: 0,
    candidates: 0,
    skips: 0,
    syncStatus: 0,
    externalVariationChildren: 0,
  };
}

function nonZero(holds: Holds): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(holds)) {
    if (value > 0) out[key] = value;
  }
  return out;
}

/** Holdings that are more than a checklist: what the operator loses. */
function isBeyondChecklist(holds: Holds): boolean {
  return (
    holds.crossListingsIn > 0 ||
    holds.crossListingsOut > 0 ||
    holds.reviewQueue > 0 ||
    holds.candidates > 0 ||
    holds.cardsWithImages > 0 ||
    holds.externalVariationChildren > 0
  );
}

type Blocker = {
  cardId: Id<"cardChecklist">;
  childCardId: Id<"cardChecklist">;
  childSelectorOptionId: Id<"selectorOptions">;
};

type DryRunResult = {
  mode: "dryRun";
  armed: boolean;
  target: TargetInfo;
  totals: TableCounts;
  beyondChecklist: Array<{
    id: Id<"selectorOptions">;
    level: Doc<"selectorOptions">["level"];
    value: string;
    holds: Record<string, number>;
  }>;
  blockers: Blocker[];
  note: string;
  rows?: Array<{
    id: Id<"selectorOptions">;
    level: Doc<"selectorOptions">["level"];
    value: string;
    parentId: Id<"selectorOptions">;
    bsc: Record<string, string>;
    sportlots: Record<string, string>;
    holds: Record<string, number>;
  }>;
};

type AppliedResult = {
  mode: "applied";
  complete: boolean;
  deleted: TableCounts;
  notEmpty: Id<"selectorOptions">[];
  message: string;
};

async function survey(
  ctx: ActionCtx,
  target: TargetInfo,
  detail: boolean,
): Promise<DryRunResult> {
  const nodes = await walkSubtree(ctx, target.id);
  const nodeIds = new Set<string>(nodes.map((node) => node.id));
  const holdsById = new Map<string, Holds>();
  for (const node of nodes) holdsById.set(node.id, emptyHolds());
  for (const node of nodes) {
    const parent = holdsById.get(node.parentId);
    if (parent) parent.children += 1;
  }

  const totals = zeroCounts();
  for (const node of nodes) countNodeLevel(totals, node.level);
  totals.selectorSyncStatus += target.statusRows;

  // Cards first: classifying a cross-listing INTO a row needs to know
  // whether the card it lists is itself going.
  const cardIds = new Set<string>();
  const crossListingIds = new Set<string>();
  const blockers: Blocker[] = [];
  for (const node of nodes) {
    const holds = holdsById.get(node.id)!;
    let cursor: string | null = null;
    for (;;) {
      const page: {
        cardIds: Id<"cardChecklist">[];
        withImages: number;
        crossOut: Array<{
          id: Id<"cardCrossListings">;
          guestId: Id<"selectorOptions">;
        }>;
        childrenElsewhere: Blocker[];
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.wipeVariantTypeSubtree.surveyCardsPage, {
        nodeId: node.id,
        cursor,
      });
      for (const id of page.cardIds) cardIds.add(id);
      holds.cards += page.cardIds.length;
      holds.cardsWithImages += page.withImages;
      for (const link of page.crossOut) {
        crossListingIds.add(link.id);
        if (nodeIds.has(link.guestId)) holds.crossListingsInternal += 1;
        else holds.crossListingsOut += 1;
      }
      for (const child of page.childrenElsewhere) {
        if (!nodeIds.has(child.childSelectorOptionId)) {
          blockers.push(child);
          holds.externalVariationChildren += 1;
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  totals.cardChecklist = cardIds.size;

  for (let i = 0; i < nodes.length; i += SURVEY_NODE_GROUP) {
    const group = nodes.slice(i, i + SURVEY_NODE_GROUP).map((node) => node.id);
    const probes: Array<{
      nodeId: Id<"selectorOptions">;
      entityReviewQueue: number;
      checklistCandidates: number;
      entityReviewSkips: number;
      crossIn: Array<{
        id: Id<"cardCrossListings">;
        cardId: Id<"cardChecklist">;
      }>;
      selectorSyncStatus: number;
      saturated: RefTable[];
    }> = await ctx.runQuery(internal.wipeVariantTypeSubtree.surveyNodeRefs, {
      nodeIds: group,
    });
    for (const probe of probes) {
      const holds = holdsById.get(probe.nodeId)!;
      const counted: Record<RefTable, number> = {
        entityReviewQueue: probe.entityReviewQueue,
        checklistCandidates: probe.checklistCandidates,
        entityReviewSkips: probe.entityReviewSkips,
        cardCrossListings: probe.crossIn.length,
      };
      let crossIn = probe.crossIn;
      for (const table of probe.saturated) {
        let total = 0;
        const links: typeof crossIn = [];
        let cursor: string | null = null;
        for (;;) {
          const page: {
            count: number;
            crossIn: typeof crossIn;
            isDone: boolean;
            continueCursor: string;
          } = await ctx.runQuery(internal.wipeVariantTypeSubtree.countRefsPage, {
            nodeId: probe.nodeId,
            table,
            cursor,
          });
          total += page.count;
          links.push(...page.crossIn);
          if (page.isDone) break;
          cursor = page.continueCursor;
        }
        counted[table] = total;
        if (table === "cardCrossListings") crossIn = links;
      }
      holds.reviewQueue += counted.entityReviewQueue;
      holds.candidates += counted.checklistCandidates;
      holds.skips += counted.entityReviewSkips;
      holds.syncStatus += probe.selectorSyncStatus;
      for (const link of crossIn) {
        // A junction whose card is also going was counted on the card's row.
        if (!cardIds.has(link.cardId)) holds.crossListingsIn += 1;
        crossListingIds.add(link.id);
      }
      totals.entityReviewQueue += counted.entityReviewQueue;
      totals.checklistCandidates += counted.checklistCandidates;
      totals.entityReviewSkips += counted.entityReviewSkips;
      totals.selectorSyncStatus += probe.selectorSyncStatus;
    }
  }
  totals.cardCrossListings = crossListingIds.size;

  const beyondChecklist = [];
  for (const node of nodes) {
    const holds = holdsById.get(node.id)!;
    if (!isBeyondChecklist(holds)) continue;
    beyondChecklist.push({
      id: node.id,
      level: node.level,
      value: node.value,
      holds: nonZero(holds),
    });
  }

  return {
    mode: "dryRun",
    armed: deploymentIsArmed(),
    target,
    totals,
    beyondChecklist,
    blockers,
    note: NO_INVENTORY_NOTE,
    ...(detail
      ? {
          rows: nodes.map((node) => ({
            id: node.id,
            level: node.level,
            value: node.value,
            parentId: node.parentId,
            bsc: node.bsc,
            sportlots: node.sportlots,
            holds: nonZero(holdsById.get(node.id)!),
          })),
        }
      : {}),
  };
}

async function applyWipe(
  ctx: ActionCtx,
  target: TargetInfo,
  confirm: string,
  batchSize: number | undefined,
  timeBudgetMs: number,
): Promise<AppliedResult> {
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt >= timeBudgetMs;
  const deleted = zeroCounts();
  const notEmpty: Id<"selectorOptions">[] = [];
  const armed = { variantTypeId: target.id, confirm };
  const cardLimit = clampPage(batchSize, CARD_PAGE_DEFAULT);
  const refLimit = clampPage(batchSize, REF_PAGE_DEFAULT);
  const nodeGroup = clampPage(batchSize, NODE_GROUP_DEFAULT);

  const partial = (): AppliedResult => ({
    mode: "applied",
    complete: false,
    deleted,
    notEmpty,
    message:
      "Stopped at the time budget with rows left. Re-run the same command " +
      "until complete is true; the counts are what this call deleted.",
  });

  const nodes = await walkSubtree(ctx, target.id);
  const maxDepth = nodes.reduce((max, node) => Math.max(max, node.depth), 0);

  for (let depth = maxDepth; depth >= 1; depth -= 1) {
    const level = nodes.filter((node) => node.depth === depth);
    for (const node of level) {
      for (;;) {
        const page: {
          cardChecklist: number;
          cardCrossListings: number;
          hasMore: boolean;
        } = await ctx.runMutation(
          internal.wipeVariantTypeSubtree.wipeCardsPage,
          { ...armed, nodeId: node.id, limit: cardLimit },
        );
        deleted.cardChecklist += page.cardChecklist;
        deleted.cardCrossListings += page.cardCrossListings;
        const worked = page.cardChecklist + page.cardCrossListings > 0;
        if (worked && outOfTime()) return partial();
        if (!page.hasMore) break;
      }
      for (;;) {
        const page: {
          entityReviewQueue: number;
          checklistCandidates: number;
          entityReviewSkips: number;
          cardCrossListings: number;
          selectorSyncStatus: number;
          hasMore: boolean;
        } = await ctx.runMutation(
          internal.wipeVariantTypeSubtree.wipeNodeRefsPage,
          { ...armed, nodeId: node.id, limit: refLimit },
        );
        deleted.entityReviewQueue += page.entityReviewQueue;
        deleted.checklistCandidates += page.checklistCandidates;
        deleted.entityReviewSkips += page.entityReviewSkips;
        deleted.cardCrossListings += page.cardCrossListings;
        deleted.selectorSyncStatus += page.selectorSyncStatus;
        const worked =
          page.entityReviewQueue +
            page.checklistCandidates +
            page.entityReviewSkips +
            page.cardCrossListings +
            page.selectorSyncStatus >
          0;
        if (worked && outOfTime()) return partial();
        if (!page.hasMore) break;
      }
    }
    for (let i = 0; i < level.length; i += nodeGroup) {
      const result: {
        insert: number;
        parallel: number;
        other: number;
        selectorSyncStatus: number;
        notEmpty: Id<"selectorOptions">[];
      } = await ctx.runMutation(
        internal.wipeVariantTypeSubtree.deleteEmptyNodes,
        {
          ...armed,
          nodeIds: level.slice(i, i + nodeGroup).map((node) => node.id),
        },
      );
      deleted.selectorOptions.insert += result.insert;
      deleted.selectorOptions.parallel += result.parallel;
      deleted.selectorOptions.other += result.other;
      deleted.selectorOptions.total +=
        result.insert + result.parallel + result.other;
      deleted.selectorSyncStatus += result.selectorSyncStatus;
      notEmpty.push(...result.notEmpty);
      const worked = result.insert + result.parallel + result.other > 0;
      if (worked && outOfTime()) return partial();
    }
  }

  const finished: {
    selectorSyncStatus: number;
    childrenRemaining: number;
    childrenCacheCleared: boolean;
  } = await ctx.runMutation(
    internal.wipeVariantTypeSubtree.finalizeVariantType,
    armed,
  );
  deleted.selectorSyncStatus += finished.selectorSyncStatus;

  const complete = finished.childrenRemaining === 0 && notEmpty.length === 0;
  return {
    mode: "applied",
    complete,
    deleted,
    notEmpty,
    message: complete
      ? "Wiped. The variant type row and its marketplace links are kept; " +
        "re-sync its column to rebuild the inserts."
      : "Rows appeared or stayed under the variant type during the run " +
        "(notEmpty). Close every Set Builder tab and re-run.",
  };
}

export const run = internalAction({
  args: {
    variantTypeId: v.id("selectorOptions"),
    /** Default true. Only `false` writes, and only when armed and confirmed. */
    dryRun: v.optional(v.boolean()),
    /** `wipe <variant type name> under <set path>`, as the dry run prints it. */
    confirm: v.optional(v.string()),
    /** Dry run only: add one entry per row. */
    detail: v.optional(v.boolean()),
    /** Lowers every page size. For tests and a cautious first pass. */
    batchSize: v.optional(v.number()),
    /** Lowers the per-call time budget (never raises it). */
    timeBudgetMs: v.optional(v.number()),
  },
  returns: v.union(
    v.object({
      mode: v.literal("dryRun"),
      armed: v.boolean(),
      target: targetValidator,
      totals: tableCountsValidator,
      beyondChecklist: v.array(lossValidator),
      blockers: v.array(blockerValidator),
      note: v.string(),
      rows: v.optional(v.array(rowReportValidator)),
    }),
    v.object({
      mode: v.literal("applied"),
      complete: v.boolean(),
      deleted: tableCountsValidator,
      notEmpty: v.array(v.id("selectorOptions")),
      message: v.string(),
    }),
  ),
  handler: async (ctx, args): Promise<DryRunResult | AppliedResult> => {
    const target: TargetInfo = await ctx.runQuery(
      internal.wipeVariantTypeSubtree.readTarget,
      { variantTypeId: args.variantTypeId },
    );

    if (args.dryRun !== false) {
      const report = await survey(ctx, target, args.detail === true);
      console.log(
        JSON.stringify({
          msg: "wipe_variant_type_subtree_dry_run",
          variantTypeId: target.id,
          totals: report.totals,
          beyondChecklist: report.beyondChecklist.length,
          blockers: report.blockers.length,
        }),
      );
      return report;
    }

    // Refuse before the first write, not inside it; every mutation asserts
    // both again on its own.
    if (!deploymentIsArmed()) throw new ConvexError(NOT_ARMED_MESSAGE);
    if (args.confirm !== target.confirmPhrase) {
      throw new ConvexError(
        `Refused: confirm does not match. For this variant type it must be ` +
          `exactly "${target.confirmPhrase}". Nothing was written.`,
      );
    }

    const budget = Math.max(
      0,
      Math.min(args.timeBudgetMs ?? TIME_BUDGET_MS, TIME_BUDGET_MS),
    );
    const result = await applyWipe(
      ctx,
      target,
      args.confirm,
      args.batchSize,
      budget,
    );
    console.log(
      JSON.stringify({
        msg: "wipe_variant_type_subtree_run",
        variantTypeId: target.id,
        complete: result.complete,
        deleted: result.deleted,
        notEmpty: result.notEmpty.length,
      }),
    );
    return result;
  },
});
