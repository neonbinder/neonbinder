/**
 * NEO-237 — moving a set out of the year's Unknown row and under a brand.
 *
 * A PURE NB OPERATION. The set row keeps its `_id`, its subtree, its
 * marketplace slots and its cards; the writes are `parentId` on the row, its
 * `features.manufacturer` snapshot (below), and the `children` caches of the
 * two parents (filtered off the old one, unioned into the new one —
 * `unionChildren`, the precedent being `applyParallelGroupings`' reparenting).
 * Nothing here reads a marketplace value: the prefix comes from the brand
 * row's `metadata.setNamePrefix`, and the only name compared is the set row's
 * own NB display value.
 *
 * THE MANUFACTURER SNAPSHOT MOVES WITH THE ROW. `features` on a set row is a
 * copy of its parent's features taken at creation (`storeSelectorOptions`'
 * insert branch), and a row born under Unknown carries no `manufacturer` key
 * because Unknown has none (`ensureBrandUnknownRow`). Once the row is that
 * brand's set, a snapshot still pointing at Unknown's absence would be a lie
 * about its own parent, so `features.manufacturer` is set to the target
 * brand's — which makes the moved row indistinguishable from a sibling the
 * sync would have inserted under that brand. The row's other features are
 * kept; the key is removed when the brand carries none. ROW-LEVEL ONLY:
 * cards already committed under the row are not rewritten, the same rule the
 * Unknown rename applies (§2a).
 *
 * ONE DIRECTION ONLY FOR THE AUTOMATIC DOORS: Unknown → brand. NEO-294 adds
 * a fourth, OPERATOR-INITIATED door — the attributes panel's move control —
 * which may name any manufacturer of the year INCLUDING the Unknown row, and
 * says so explicitly with `allowBrandUnknownTarget`. The refusal stays the
 * default, so a sync cannot reach that destination by accident. The three
 * automatic doors are —
 *
 *   • `addCustomSelectorOption` at the manufacturer level (a new brand
 *     claims the sets whose names start with its prefix);
 *   • `setSelectorOptionSetNamePrefix` (an edited prefix claims likewise —
 *     "Choice" typed with prefix "Choice Biloxi" moves nothing, and fixing
 *     the prefix is how the operator moves it);
 *   • the Sync Sets BSC phase (`routeBscSets`' `moves`: a row that sits
 *     under Unknown holding a BSC id, and whose OWN NB name now matches a
 *     brand's prefix — never the marketplace's name for that set, which
 *     would let an upstream label move a row an operator has renamed).
 *
 * Never brand → brand, and never from a sync on a row already under a brand:
 * a placement is linkage, and the sync's job is to route a marketplace's
 * update to the row linked to it, not to second-guess where the row lives.
 *
 * SIBLING CLASH. Two rows under one parent must not fold to one name (the
 * NEO-219 rule every picker and drill util relies on), so a set whose name
 * already exists under the target brand STAYS under Unknown, counted and
 * logged, never renamed and never merged. The operator resolves it by hand —
 * which is the right outcome, because two same-named sets under one brand is
 * a question about which one is which, and a sync must not answer it. That
 * check is bounded by `MAX_YEAR_SET_ROWS` and FAILS CLOSED past it
 * (`rehomeTargetTooLargeRefusal`): a half-read sibling list would let the
 * move create the exact duplicate the check prevents.
 */

import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  matchesBrandPrefix,
  selectorValueKey,
  valuesDeepEqual,
} from "./selectorSyncMatch";
import { unionChildren } from "./selectorSyncStore";
import { MAX_YEAR_SET_ROWS } from "./setFromMarketplace";
import { resolvableSides, type ResolvableRow } from "./marketplaceResolvability";
import { pausedSides } from "./marketplacePause";
import { initialSlots } from "./platformSlots";
import { SL_ALL_BRANDS_BRAND_ID } from "./slBrandAxis";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";
import { inheritedTeamIds } from "./lib/selectorTeams";

/**
 * The "N sets moved out of Unknown" notice, one sentence for the two doors
 * that write it into `selectorSyncStatus` (`addCustomSelectorOption`, and
 * `setSelectorOptionSetNamePrefix` in brandView.ts). Counts only — a set name
 * is operator content and the status message is reactive state (NEO-47).
 */
export function rehomedNotice(count: number): string {
  return `${countNoun(count, "set")} moved out of Unknown`;
}

/**
 * NEO-294 (audit condition 2) — the refusal when the target brand holds more
 * sets than the sibling-clash read may cover. A `ConvexError` rather than an
 * `Error` so the sentence survives to whoever is looking (production redacts
 * a plain Error to "Server Error"); named and exported so the test and the
 * message cannot drift apart.
 */
export const rehomeTargetTooLargeRefusal = (brandName: string): string =>
  `${brandName} has more than ${MAX_YEAR_SET_ROWS} sets — too many to check ` +
  `a set's name against, so nothing was moved under it.`;

/**
 * "1 set" / "3 sets" / "0 brands" — the one pluraliser behind every count the
 * Sync Sets summary shows the operator. Never "(s)": the summary is read by a
 * collector, not a developer. `plural` defaults to `singular + "s"`.
 */
export function countNoun(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export type RehomeResult = {
  /** Rows whose `parentId` now names the brand. */
  rehomed: number;
  /** Rows left under their old parent because the brand already had that name. */
  clashes: number;
  /**
   * NEO-294 — rows left alone because an operator placed them
   * (`metadata.brandSetByOperator`). Always 0 on the operator's own move,
   * which passes `includeOperatorPlaced`.
   */
  operatorPlaced: number;
};

/** "Nothing to do" — the ordinary case on a fresh year, not an error. */
const EMPTY_REHOME: RehomeResult = { rehomed: 0, clashes: 0, operatorPlaced: 0 };

/**
 * NEO-296 — what one `rehomeSetsFromBrandUnknown` PAGE did, and whether more
 * is being done behind it.
 */
export type RehomeRunResult = RehomeResult & {
  /**
   * A scheduled continuation is still moving matches. The rows this page moved
   * are committed either way; this says only that the operator is looking at a
   * partial count for another moment.
   */
  draining: boolean;
};

/**
 * NEO-296 — how far ONE transaction walks the year's Unknown row, and how many
 * of the matches it finds there it moves.
 *
 * ## The arithmetic
 *
 * A move is ONE `db.patch` on the set row. Everything else a page does is
 * fixed: one read for the year's manufacturers, one `db.get` for the brand,
 * one `.take()` for the target's sibling names, one `.take()` for the page of
 * Unknown's sets, one `db.get` + one patch to drop the moved ids out of
 * Unknown's `children`, one patch to union them into the brand's, and one
 * `scheduler.runAfter` when there is a remainder — about nine. So
 *
 *     500 moves x 1  +  ~9 fixed  =  ~509 operations
 *
 * against the ~900 this codebase treats as comfortable (~1,800 strains,
 * ~4,000 fails — `CARDS_PER_COMMIT_CHUNK` in selectorOptions.ts). Unbounded,
 * this was one patch per matching set in the operator's OWN transaction: a
 * dev year already holds ~1,000 sets under Unknown and a full baseball year
 * puts a large share of ~2,700 there, so a brand whose prefix claims most of
 * them was ~2,700 operations — and because it was all-or-nothing, the abort
 * took the prefix edit (or the brand insert) down with it. The operator's own
 * write now commits with the first page, whatever the rest costs.
 *
 * ## Two bounds, because scanning and moving cost different things
 *
 * `scan` is how many of Unknown's rows one page READS looking for matches —
 * one operation for the whole `.take()`, whatever it returns — and `move`
 * caps the patches. They are separate because a narrow prefix over a big
 * Unknown row is the common case: "Bowman" over 1,000 sets should not cost
 * one transaction per 500 rows READ when it is only going to move twelve.
 * The cursor is the last row EXAMINED, never the last row moved, or the rows a
 * spent move budget left unread would be skipped forever.
 */
export const REHOME_PAGE = { scan: 1000, move: 500 } as const;

/** One page's two bounds, already clamped. */
type RehomePage = { scan: number; move: number };

/**
 * Clamp a caller's page down to `REHOME_PAGE`.
 *
 * The page is an ARGUMENT rather than a constant read at the point of use, for
 * the reason `readTeamFillCards`' `budget` is: a test can force the multi-page
 * path without seeding a thousand rows. It can only make a page SMALLER — the
 * bound above is the transaction's ceiling, and nothing, test or caller, gets
 * to raise it.
 */
function clampPage(page: Partial<RehomePage> | undefined): RehomePage {
  const clamp = (value: number | undefined, ceiling: number): number =>
    value === undefined || !Number.isFinite(value)
      ? ceiling
      : Math.min(ceiling, Math.max(1, Math.floor(value)));
  return {
    scan: clamp(page?.scan, REHOME_PAGE.scan),
    move: clamp(page?.move, REHOME_PAGE.move),
  };
}

/**
 * How many pages one chain walks before it stops and says so.
 *
 * 12 x 500 is 6,000 sets — twice `MAX_YEAR_SET_ROWS`, so a real year finishes
 * long before it. Reaching it means the walk is not making progress the way
 * it should, and a chain that will not stop is worse than a chain that logs
 * what it left. Truncation is warned about, never silent.
 */
export const REHOME_MAX_PAGES = 12;

/**
 * The per-transaction ceiling `rehomeSetRowsToBrand` is sized for.
 *
 * NOT enforced — the row list is the caller's, and silently dropping the tail
 * of a list a caller gathered itself would be worse than the cost it saves.
 * `rehomeSetsFromBrandUnknown` never hands over more than `REHOME_PAGE.move`;
 * a caller that can hand over more (the set sync's own `moves` list, the
 * known-brands backfill) gets a warning in the log naming the count, so an
 * over-budget transaction is visible before it is a timeout.
 */
export const REHOME_ROWS_PER_TRANSACTION = REHOME_PAGE.move;

/**
 * The year's brand-unknown row, found by its NB ROLE and nothing else. `null`
 * when the year has none yet (nothing has been synced under it).
 *
 * One indexed read over the year's manufacturers. The first flagged row wins
 * if a year somehow carries two — `ensureBrandUnknownRow` never mints a
 * second, so that is a hand-edit, and the sync should still behave.
 */
export async function findBrandUnknownRow(
  ctx: { db: QueryCtx["db"] },
  yearId: Id<"selectorOptions">,
): Promise<Doc<"selectorOptions"> | null> {
  const manufacturers = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "manufacturer").eq("parentId", yearId),
    )
    .collect();
  return manufacturers.find((m) => m.metadata?.isBrandUnknown === true) ?? null;
}

/**
 * The moved row's `features` once it is `brandManufacturer`'s set: the row's
 * own features with `manufacturer` replaced by the brand's snapshot, or
 * removed when the brand has none. `undefined` when nothing would be left —
 * the caller removes the field rather than storing `{}`, matching how the
 * insert branch stores a row with no features.
 */
export function rehomedFeatures(
  rowFeatures: Record<string, string> | undefined,
  brandManufacturer: string | undefined,
): Record<string, string> | undefined {
  const next: Record<string, string> = { ...(rowFeatures ?? {}) };
  if (brandManufacturer !== undefined) next.manufacturer = brandManufacturer;
  else delete next.manufacturer;
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Move specific setName rows under `brandId`. The shared core: the two
 * name-driven doors above filter Unknown's sets by prefix and hand the
 * survivors here; the sync hands over the rows `routeBscSets` named by id.
 *
 * `rows` must be `setName` rows; anything else is skipped and counted as
 * nothing. A row already under the brand is a no-op, not a clash.
 *
 * TWO NEO-294 OPTIONS, both default-false so every existing caller keeps the
 * behaviour it was written against:
 *
 *   allowBrandUnknownTarget — the target may be the year's flagged Unknown
 *     row. Only the operator's move passes it: "move this set back to
 *     Unknown" is a legitimate destination for a person and never for a
 *     sync, which would be undoing its own work.
 *   includeOperatorPlaced — rows carrying `metadata.brandSetByOperator` are
 *     moved rather than skipped. Only the operator's move passes it: a
 *     second decision by the same hand is still theirs, while an automatic
 *     path must never take a row back off the brand a person chose.
 */
export async function rehomeSetRowsToBrand(
  ctx: MutationCtx,
  args: {
    rows: readonly Doc<"selectorOptions">[];
    brandId: Id<"selectorOptions">;
    /** NEO-294 — the operator's move may name the flagged Unknown row. */
    allowBrandUnknownTarget?: boolean;
    /** NEO-294 — the operator's move may re-place a row they placed before. */
    includeOperatorPlaced?: boolean;
  },
): Promise<RehomeResult> {
  const brand = await ctx.db.get(args.brandId);
  if (!brand || brand.level !== "manufacturer") {
    throw new Error("rehomeSetRowsToBrand: target is not a manufacturer row");
  }
  if (args.rows.length > REHOME_ROWS_PER_TRANSACTION) {
    // Counts only (NEO-47's rule, applied to logs). Not a refusal: the list is
    // the caller's, and dropping its tail would be worse than the cost. See
    // REHOME_ROWS_PER_TRANSACTION for who can still get here.
    console.warn(
      `[brandRehome] ${args.rows.length} rows in one transaction, past the ` +
        `${REHOME_ROWS_PER_TRANSACTION} this move is sized for.`,
    );
  }
  if (
    brand.metadata?.isBrandUnknown === true &&
    args.allowBrandUnknownTarget !== true
  ) {
    throw new Error("rehomeSetRowsToBrand: target is the brand-unknown row");
  }

  // The target's IN-TRANSACTION name set, grown as rows land, so two Unknown
  // rows that fold to one name cannot both move.
  //
  // BOUNDED, AND FAILS CLOSED (NEO-294 audit, condition 2): the year's
  // Unknown row is a legal target for the operator's move and is the biggest
  // bucket there is, so this read carries `MAX_YEAR_SET_ROWS` like every
  // other year-scoped set read. A truncated sibling list cannot answer "is
  // this name taken?", and re-homing against a half-read answer would put
  // two fold-equal names under one parent — the NEO-219 rule this function
  // upholds. Refuse instead; nothing is written.
  const targetSiblings = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "setName").eq("parentId", args.brandId),
    )
    .take(MAX_YEAR_SET_ROWS + 1);
  if (targetSiblings.length > MAX_YEAR_SET_ROWS) {
    throw new ConvexError(rehomeTargetTooLargeRefusal(brand.value));
  }
  const takenKeys = new Set(targetSiblings.map((r) => selectorValueKey(r.value)));

  const now = Date.now();
  const movedIds: Id<"selectorOptions">[] = [];
  const removedFrom = new Map<Id<"selectorOptions">, Set<Id<"selectorOptions">>>();
  let clashes = 0;
  let operatorPlaced = 0;

  for (const row of args.rows) {
    if (row.level !== "setName") continue;
    if (row.parentId === args.brandId) continue;
    // NEO-294 — the operator's placement outranks every automatic caller.
    // Counted, not silent: the sync's summary and the backfill's report both
    // say how many rows they left alone.
    if (
      row.metadata?.brandSetByOperator === true &&
      args.includeOperatorPlaced !== true
    ) {
      operatorPlaced++;
      continue;
    }
    const key = selectorValueKey(row.value);
    if (takenKeys.has(key)) {
      clashes++;
      continue;
    }
    takenKeys.add(key);
    // NEO-85: write-if-changed on `features` — a row that already carries the
    // brand's manufacturer (a hand-edited snapshot) is not rewritten.
    const nextFeatures = rehomedFeatures(row.features, brand.features?.manufacturer);
    const featuresChanged = !valuesDeepEqual(row.features ?? {}, nextFeatures ?? {});
    await ctx.db.patch(row._id, {
      parentId: args.brandId,
      lastUpdated: now,
      // `undefined` removes the field: a row with no features left is stored
      // the way the insert branch stores one, with no `features` key at all.
      ...(featuresChanged ? { features: nextFeatures } : {}),
    });
    movedIds.push(row._id);
    if (row.parentId) {
      const set = removedFrom.get(row.parentId) ?? new Set<Id<"selectorOptions">>();
      set.add(row._id);
      removedFrom.set(row.parentId, set);
    }
  }

  if (movedIds.length > 0) {
    // NEO-85: write-if-changed on every `children` cache, as everywhere else
    // in this tree — a byte-identical patch still reflows every column
    // watching the parent.
    for (const [fromId, ids] of removedFrom) {
      const from = await ctx.db.get(fromId);
      if (!from) continue;
      const next = (from.children ?? []).filter((id) => !ids.has(id));
      if (!valuesDeepEqual(from.children ?? [], next)) {
        await ctx.db.patch(fromId, { children: next, lastUpdated: now });
      }
    }
    const nextChildren = unionChildren(brand.children, movedIds);
    if (!valuesDeepEqual(brand.children ?? [], nextChildren)) {
      await ctx.db.patch(args.brandId, { children: nextChildren, lastUpdated: now });
    }
  }

  if (clashes > 0) {
    // Counts only — a set name is operator content and the log is not the
    // place for it (NEO-47's rule, applied to logs).
    console.warn(
      `[brandRehome] ${clashes} set(s) stayed under their old parent: the ` +
        `target brand already has a set of that name.`,
    );
  }
  return { rehomed: movedIds.length, clashes, operatorPlaced };
}

/**
 * ONE page of "re-home every set under the year's Unknown row whose NB name
 * starts with `prefix`".
 *
 * The name compared is the SET ROW'S OWN VALUE — NB data — against a prefix
 * that is NB data on the brand row. An empty prefix moves nothing, and a year
 * with no Unknown row has nothing to move; both return zeros rather than
 * throwing, because "nothing to do" is the ordinary case on a fresh year.
 *
 * Walks `by_level_and_parent` with a `_creationTime` cursor rather than
 * `.paginate()`: `_creationTime` is the implicit last column of every index
 * and unique within a table, so "strictly after it" is an exact resume point,
 * and Convex allows one `.paginate()` per execution while a chain of
 * transactions is not one execution. The same walk `readTeamFillCards` and
 * `entityReviewQueue`'s bulk decide do.
 *
 * `cursor` is the last row EXAMINED — including rows this page deliberately
 * left where they were (a name clash, an operator placement, a non-match).
 * A run is one PASS: it does not come back for them, which is what stops a
 * page whose whole budget went on clashes from being walked forever.
 */
async function rehomeFromBrandUnknownPage(
  ctx: MutationCtx,
  args: {
    yearId: Id<"selectorOptions">;
    brandId: Id<"selectorOptions">;
    prefix: string;
    cursor?: number;
    page?: Partial<RehomePage>;
  },
): Promise<RehomeResult & { cursor: number | null; hasMore: boolean }> {
  const bounds = clampPage(args.page);
  const idle = { ...EMPTY_REHOME, cursor: null, hasMore: false };
  const prefix = args.prefix.trim();
  if (!prefix) return idle;

  const unknown = await findBrandUnknownRow(ctx, args.yearId);
  if (!unknown || unknown._id === args.brandId) return idle;

  const after = args.cursor;
  const page = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      after === undefined
        ? q.eq("level", "setName").eq("parentId", unknown._id)
        : q.eq("level", "setName").eq("parentId", unknown._id).gt("_creationTime", after),
    )
    .take(bounds.scan);

  const matching: Doc<"selectorOptions">[] = [];
  let examined = 0;
  let budgetSpent = false;
  for (const row of page) {
    if (matchesBrandPrefix(row.value, prefix)) {
      if (matching.length === bounds.move) {
        // The move budget is gone. Stop BEFORE counting this row as examined,
        // so the cursor leaves it for the next page.
        budgetSpent = true;
        break;
      }
      matching.push(row);
    }
    examined += 1;
  }

  const lastExamined = examined > 0 ? page[examined - 1]._creationTime : (after ?? null);
  const hasMore = budgetSpent || page.length === bounds.scan;
  if (matching.length === 0) {
    return { ...EMPTY_REHOME, cursor: lastExamined, hasMore };
  }
  const moved = await rehomeSetRowsToBrand(ctx, {
    rows: matching,
    brandId: args.brandId,
  });
  return { ...moved, cursor: lastExamined, hasMore };
}

/**
 * Re-home the sets under the year's Unknown row whose NB names start with
 * `prefix` — the first page here, the rest behind a scheduled continuation.
 *
 * ## Why the remainder is scheduled rather than returned
 *
 * Both doors into this are a mutation doing something ELSE first: minting the
 * brand row (`addCustomSelectorOption`) or writing the edited prefix
 * (`setSelectorOptionSetNamePrefix`). That write is the operator's actual
 * request and it must commit. Before NEO-296 the whole re-home rode in its
 * transaction, so a year whose Unknown row held thousands of matching sets
 * could blow the operation budget and roll the operator's edit back with it —
 * the edit LOOKED refused, and repeating it refused again.
 *
 * So the first page commits WITH that write, and a `selectorSyncStatus`-free
 * continuation carries on: every page its own transaction, each one durable
 * on its own. There is no client in this loop to drive it (the sets column is
 * reactive and the operator has already moved on), which is why this is a
 * schedule rather than the `{ hasMore, cursor }` hand-back
 * `entityReviewQueue.decideAllRemaining` gives the wizard.
 *
 * ## What the operator sees while it drains
 *
 * The brand's Sets column fills in, a page at a time, over the following
 * moment; nothing is ever half-moved, because a set is moved by one patch.
 * The count in the answer (`rehomed`) is this page's — `draining` says
 * whether it is the whole story.
 *
 * ## Resuming, and never moving a row twice
 *
 * A moved row is no longer under Unknown, so it is not in any later page's
 * index range at all; `rehomeSetRowsToBrand` no-ops on a row already under
 * the brand besides. An interrupted chain (a deploy, a failed page) therefore
 * loses only the pages it never ran, and the next call of either door — or
 * the next Sync Sets — picks the rest up from the start with nothing moved
 * twice.
 */
export async function rehomeSetsFromBrandUnknown(
  ctx: MutationCtx,
  args: {
    yearId: Id<"selectorOptions">;
    brandId: Id<"selectorOptions">;
    prefix: string;
    /** Test-only narrowing of the page; see `clampPage`. */
    page?: Partial<RehomePage>;
  },
): Promise<RehomeRunResult> {
  const page = await rehomeFromBrandUnknownPage(ctx, args);
  const result: RehomeRunResult = {
    rehomed: page.rehomed,
    clashes: page.clashes,
    operatorPlaced: page.operatorPlaced,
    draining: false,
  };
  if (!page.hasMore || page.cursor === null) return result;

  await ctx.scheduler.runAfter(0, internal.brandRehome.rehomeFromBrandUnknownBatch, {
    yearId: args.yearId,
    brandId: args.brandId,
    prefix: args.prefix,
    cursor: page.cursor,
    pagesLeft: REHOME_MAX_PAGES,
    ...(args.page !== undefined ? { page: clampPage(args.page) } : {}),
  });
  return { ...result, draining: true };
}

/**
 * The continuation behind `rehomeSetsFromBrandUnknown` — one page, then
 * itself again while there is more.
 *
 * ## It re-checks that the prefix it was scheduled for is still the brand's
 *
 * `metadata.setNamePrefix` is what both doors set and what this chain claims
 * rows by, so a chain whose prefix is no longer on the brand row belongs to an
 * edit the operator has replaced. It stops, and the edit that replaced it
 * started its own chain. Without this, "Choice Biloxi" corrected to "Choice"
 * a second later would leave the first chain still claiming rows under a rule
 * nobody asked for any more.
 *
 * `pagesLeft` is the runaway stop. A chain that spends it logs the count it
 * reached rather than dropping the remainder quietly; the doors and the set
 * sync all re-walk from the start next time.
 */
export const rehomeFromBrandUnknownBatch = internalMutation({
  args: {
    yearId: v.id("selectorOptions"),
    brandId: v.id("selectorOptions"),
    prefix: v.string(),
    /** `_creationTime` of the last row the previous page examined. */
    cursor: v.number(),
    pagesLeft: v.number(),
    /** Test-only narrowing of the page, carried along the chain; see `clampPage`. */
    page: v.optional(v.object({ scan: v.number(), move: v.number() })),
  },
  returns: v.object({
    rehomed: v.number(),
    clashes: v.number(),
    operatorPlaced: v.number(),
    done: v.boolean(),
    /**
     * Where the next page resumes, absent on the last one. Returned as well as
     * scheduled because convex-test does not auto-run scheduled functions, so
     * a test driving the chain by hand needs the cursor the page computed.
     */
    nextCursor: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const brand = await ctx.db.get(args.brandId);
    if (!brand || brand.metadata?.setNamePrefix !== args.prefix) {
      return { ...EMPTY_REHOME, done: true };
    }

    const page = await rehomeFromBrandUnknownPage(ctx, {
      yearId: args.yearId,
      brandId: args.brandId,
      prefix: args.prefix,
      cursor: args.cursor,
      ...(args.page !== undefined ? { page: args.page } : {}),
    });
    const counts = {
      rehomed: page.rehomed,
      clashes: page.clashes,
      operatorPlaced: page.operatorPlaced,
    };
    if (!page.hasMore || page.cursor === null) return { ...counts, done: true };

    if (args.pagesLeft <= 1) {
      // Counts only. Stopping is the safe end of the trade — every page so far
      // is committed, and both doors re-walk from the start next time.
      console.warn(
        `[brandRehome] stopped after ${REHOME_MAX_PAGES} pages with matches ` +
          `still under Unknown; run the move again to finish it.`,
      );
      return { ...counts, done: true };
    }

    await ctx.scheduler.runAfter(0, internal.brandRehome.rehomeFromBrandUnknownBatch, {
      yearId: args.yearId,
      brandId: args.brandId,
      prefix: args.prefix,
      cursor: page.cursor,
      pagesLeft: args.pagesLeft - 1,
      ...(args.page !== undefined ? { page: args.page } : {}),
    });
    return { ...counts, done: false, nextCursor: page.cursor };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// NEO-294 — minting a brand row for a name from the known list
// ───────────────────────────────────────────────────────────────────────────

export type EnsureBrandRowResult = {
  /**
   * The brand row to file sets under, or `null` when the year already has a
   * manufacturer of that name that is NOT a usable brand — today that is
   * only the flagged Unknown row, wearing an operator's rename. Nothing is
   * created in that case and the caller leaves those sets in Unknown, which
   * is where the row in question puts them anyway.
   */
  id: Id<"selectorOptions"> | null;
  /** `true` only when this call inserted the row. */
  created: boolean;
  /**
   * The row's ACTUAL `metadata.setNamePrefix`, minted or adopted. A caller
   * that re-routes with this row in hand must use this rather than assume
   * the brand name: an adopted row written before NEO-237 may carry none,
   * and a row with no prefix buckets nothing (schema.ts).
   */
  setNamePrefix?: string;
};

/**
 * The ancestor chain a MUTATION needs to judge resolvability — the same walk
 * `getAncestorChain` does, with only the fields the rule reads. A third copy
 * of this loop, after `selectorOptions.ts` and `setReconciliation.ts`, for
 * the same reason both of those have one: a mutation cannot call the query,
 * which carries its own `requireAdmin`.
 */
async function loadChain(
  ctx: { db: QueryCtx["db"] },
  leafId: Id<"selectorOptions"> | undefined,
): Promise<ResolvableRow[]> {
  const chain: ResolvableRow[] = [];
  let currentId: Id<"selectorOptions"> | undefined = leafId;
  while (currentId) {
    const row: Doc<"selectorOptions"> | null = await ctx.db.get(currentId);
    if (!row) break;
    chain.unshift({
      level: row.level,
      value: row.value,
      platformData: row.platformData ?? {},
      platformFacets: row.platformFacets,
    });
    currentId = row.parentId;
  }
  return chain;
}

/**
 * NEO-294 — find or mint the manufacturer row called `name` under `yearId`,
 * born EXACTLY as a hand-created brand is (`addCustomSelectorOption` at the
 * manufacturer level):
 *
 *   • `metadata.setNamePrefix` = the name, the one default every creation
 *     path writes;
 *   • the SportLots ALL-BRANDS sentinel in its SportLots slot when the chain
 *     can scope SportLots (`resolvableSides` at the manufacturer level, the
 *     pause included) — unconditional otherwise, exactly as Jason asked on
 *     the NEO-237 preview. A year with no SportLots ids gets a brand with no
 *     SportLots slot, which is an ordinary row, not an error (invariant 6),
 *     and writing a link that can never be fetched would break invariant 5;
 *   • features copied down from the year plus the level's own, `teamIds`
 *     inherited, `children: []`, and the row unioned into the year's
 *     `children` cache.
 *
 * IDEMPOTENT by folded name, the same per-parent rule
 * `addCustomSelectorOption` returns on: a second call with the same name
 * returns the row the first one made and writes nothing. That is what makes
 * "sync again" and "run the backfill twice" free.
 *
 * NEVER on a flagged row: `setNamePrefix` on the row that holds the sets
 * whose brand NB has not identified is a contradiction (schema.ts), so a
 * flagged row wearing this name is reported as `id: null` rather than
 * adopted or renamed. `name` is an NB constant from `knownBrands.ts`; no
 * marketplace value reaches this function.
 */
export async function ensureBrandRowForName(
  ctx: MutationCtx,
  args: { yearId: Id<"selectorOptions">; name: string },
): Promise<EnsureBrandRowResult> {
  const name = args.name.trim();
  if (!name) throw new Error("ensureBrandRowForName: empty brand name");
  const year = await ctx.db.get(args.yearId);
  if (!year || year.level !== "year") {
    throw new Error("ensureBrandRowForName: parent is not a year row");
  }

  const siblings = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "manufacturer").eq("parentId", args.yearId),
    )
    .collect();
  const key = selectorValueKey(name);
  const existing = siblings.find((m) => selectorValueKey(m.value) === key);
  if (existing) {
    if (existing.metadata?.isBrandUnknown === true) {
      return { id: null, created: false };
    }
    return {
      id: existing._id,
      created: false,
      ...(existing.metadata?.setNamePrefix !== undefined
        ? { setNamePrefix: existing.metadata.setNamePrefix }
        : {}),
    };
  }

  const chain = await loadChain(ctx, args.yearId);
  const resolution = resolvableSides(chain, {
    level: "manufacturer",
    paused: pausedSides(),
  });
  const alloc = resolution.sportlots.resolvable
    ? initialSlots({ sportlots: [{ id: SL_ALL_BRANDS_BRAND_ID, label: name }] })
    : undefined;

  const features = {
    ...(year.features ?? {}),
    ...deriveOwnLevelFeatures("manufacturer", name),
  };
  const parentTeamIds = inheritedTeamIds(year);
  const now = Date.now();
  const id = await ctx.db.insert("selectorOptions", {
    level: "manufacturer",
    value: name,
    platformData: alloc?.platformData ?? {},
    ...(alloc ? { platformLabels: alloc.platformLabels } : {}),
    ...(alloc ? { platformSlotSeq: alloc.platformSlotSeq } : {}),
    parentId: args.yearId,
    children: [],
    metadata: { setNamePrefix: name },
    ...(Object.keys(features).length > 0 ? { features } : {}),
    ...(parentTeamIds ? { teamIds: parentTeamIds } : {}),
    lastUpdated: now,
  });
  const nextChildren = unionChildren(year.children, [id]);
  if (!valuesDeepEqual(year.children ?? [], nextChildren)) {
    await ctx.db.patch(args.yearId, { children: nextChildren, lastUpdated: now });
  }
  return { id, created: true, setNamePrefix: name };
}
