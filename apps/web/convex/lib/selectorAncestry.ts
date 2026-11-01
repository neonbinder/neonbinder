/**
 * NEO-254 — walking a selectorOption's parent chain for the facts a card
 * inherits from the set it sits in.
 *
 * `findSportForSelectorOption` (convex/cardChecklist.ts) has done exactly this
 * for the sport since NEO-96. `findSetYearForSelectorOption` was written to the
 * same shape for the card-attention roster suggestions, and NEO-254 needs it in
 * two more places — the review gate and the commit prelude, both of which use
 * the card's year to tell two same-name players apart. Three copies of a walk
 * that must agree about depth limits and about what counts as a year is three
 * chances for them to disagree, so it lives here instead.
 *
 * Typed against a minimal `ctx` shape rather than `QueryCtx`/`MutationCtx` so
 * both can call it, and so this module pulls in no generated code.
 *
 * NEO-279 added the DOWNWARD walk (`collectDescendantIds`) beside the upward
 * ones, for the same reason: three writers over one subtree must agree about
 * what the subtree is.
 *
 * NEO-334 added the variant-type rename guard (`variantTypeRenameCheck` /
 * `assertVariantTypeRenameAllowed`), which needs indexed queries, so it takes
 * `Pick<QueryCtx, "db">` (a type-only import; a mutation ctx satisfies it).
 */

import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  SUB_VARIANT_INSERT_ONLY,
  SUB_VARIANT_INSERT_ONLY_MESSAGE,
  subVariantsAllowedUnder,
  variantTypeKind,
  variantTypeKindFromTitle,
  variantTypeRenameOutcome,
  type VariantKindRow,
  type VariantTypeRenameOutcome,
} from "../variantRole";

/**
 * Depth cutoff for every walk here.
 *
 * The real hierarchy is six levels (sport → year → manufacturer → setName →
 * variantType → variant), so 16 is generous slack. Its actual job is to stop a
 * cycle in `parentId` — which a bad import or a hand-edited row can produce —
 * from wedging a reactive query or burning a mutation's read budget.
 */
const MAX_ANCESTOR_DEPTH = 16;

type AncestryCtx = {
  db: {
    get: (id: Id<"selectorOptions">) => Promise<{
      _id: Id<"selectorOptions">;
      level?: string;
      value?: string;
      parentId?: Id<"selectorOptions">;
      features?: Record<string, string | undefined>;
    } | null>;
  };
};

/**
 * A year-shaped string, or undefined. Never NaN.
 *
 * Exported since NEO-279 so the team-fill subtree read can turn a node's own
 * `features.season` into the year rule C compares stints against, with the
 * same notion of "year-shaped" the ancestor walk below uses.
 */
export function parseYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Every descendant selectorOption id beneath `rootId` (NOT including the
 * root), walked through the `children` pointer-graph.
 *
 * Moved here from selectorOptions.ts in NEO-279: feature propagation, the
 * NEO-277 team cascade and its preview, and the team-fill planner all need
 * "the whole subtree under this set", and the planner must see exactly the
 * rows the cascade would touch or its preview promises a count the apply
 * does not deliver. One walk, imported by all of them.
 *
 * UNBOUNDED: each node is one ctx.db.get, and the walk does not stop at any
 * count, so a caller pointed at a sport row walks every set beneath it —
 * (year≈30) * (manufacturer≈10) * (setName≈5) * (variantType≈3) *
 * (insert≈20) * (parallel≈5) is a few thousand reads worst case, well
 * inside a function's read budget but not free. Callers scope the root
 * themselves: `setSelectorOptionTeams` and its preview refuse a root above
 * `TEAM_EDITABLE_LEVELS`, team fill refuses anything but a `setName` row,
 * and feature propagation targets a single set or variantType (≪ 100
 * descendants) in practice. `seen` guards against a `children` cycle the
 * same way `MAX_ANCESTOR_DEPTH` guards the upward walks.
 */
export async function collectDescendantIds(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<unknown> } },
  rootId: Id<"selectorOptions">,
): Promise<Array<Id<"selectorOptions">>> {
  const out: Array<Id<"selectorOptions">> = [];
  const stack: Array<Id<"selectorOptions">> = [rootId];
  const seen = new Set<string>([rootId]);
  while (stack.length > 0) {
    const id = stack.pop()!;
    const row = (await ctx.db.get(id)) as
      | { children?: Array<Id<"selectorOptions">> }
      | null;
    if (!row?.children) continue;
    for (const childId of row.children) {
      const key = childId as unknown as string;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(childId);
      stack.push(childId);
    }
  }
  return out;
}

/**
 * The year this selectorOption's cards belong to, or undefined.
 *
 * The row's own `features.season` wins when it has one: it is the more
 * specific fact (a set can carry cards of a season other than its shelf year)
 * and it is what the SKU and title generation already read. The `year`-level
 * ancestor is the fallback, which is what every ordinary set resolves through.
 *
 * Returns undefined rather than guessing when neither exists — an orphaned
 * subtree, or a fixture built without a year row. Every NEO-254 caller treats
 * that as "cannot narrow", which sends the name to a human rather than to the
 * first row an index returned.
 */
export async function findSetYearForSelectorOption(
  ctx: AncestryCtx,
  selectorOptionId: Id<"selectorOptions">,
): Promise<number | undefined> {
  const leaf = await ctx.db.get(selectorOptionId);
  if (!leaf) return undefined;
  const fromFeatures = parseYear(leaf.features?.season);
  if (fromFeatures !== undefined) return fromFeatures;
  let cursor: Id<"selectorOptions"> | undefined = leaf.parentId;
  let depth = 0;
  while (cursor && depth < MAX_ANCESTOR_DEPTH) {
    const node = await ctx.db.get(cursor);
    if (!node) return undefined;
    if (node.level === "year") return parseYear(node.value);
    cursor = node.parentId;
    depth += 1;
  }
  return undefined;
}

/**
 * What the sub-variant gate reads of a row: where it sits, and (for the
 * variant type) its title, which is its kind. Structural, like
 * `AncestryCtx`, so a query or a mutation ctx both pass.
 */
type SubVariantGateCtx = {
  db: {
    get: (id: Id<"selectorOptions">) => Promise<
      | ({
          _id: Id<"selectorOptions">;
          level?: string;
          parentId?: Id<"selectorOptions">;
        } & VariantKindRow)
      | null
    >;
  };
};

/**
 * NEO-334 — may a `parallel`-level row be created under `parentId`?
 *
 * Only when the parent is an `insert`-level row whose own parent is a
 * `variantType` row of kind `insert` (`subVariantsAllowedUnder`: titled
 * "Insert" or "Inserts"). No parent, a missing row, a parent at another
 * level, or a variant type of any other kind (Base, Parallel, none) is a
 * no. Two point reads.
 */
export async function subVariantParentAllowed(
  ctx: SubVariantGateCtx,
  parentId: Id<"selectorOptions"> | undefined,
): Promise<boolean> {
  if (!parentId) return false;
  const insert = await ctx.db.get(parentId);
  if (!insert || insert.level !== "insert" || !insert.parentId) return false;
  const variantType = await ctx.db.get(insert.parentId);
  if (!variantType || variantType.level !== "variantType") return false;
  return subVariantsAllowedUnder(variantType);
}

/**
 * NEO-334 — the refusal every write path that creates rows at `level` under
 * `parentId` runs first. A no-op at every level but `parallel`; at
 * `parallel` it throws a structured `ConvexError`
 * (`{ code: SUB_VARIANT_INSERT_ONLY, reason }`) unless
 * `subVariantParentAllowed`. Thrown before anything is written, so a refused
 * call leaves the tree exactly as it was.
 */
export async function assertSubVariantParent(
  ctx: SubVariantGateCtx,
  level: string,
  parentId: Id<"selectorOptions"> | undefined,
): Promise<void> {
  if (level !== "parallel") return;
  if (await subVariantParentAllowed(ctx, parentId)) return;
  throw new ConvexError({
    code: SUB_VARIANT_INSERT_ONLY,
    reason: SUB_VARIANT_INSERT_ONLY_MESSAGE,
  });
}

/** The row a rename door is about to retitle, as far as the guard reads it. */
type RenameGuardRow = {
  _id: Id<"selectorOptions">;
  level?: string;
  value?: string;
  parentId?: Id<"selectorOptions">;
};

/**
 * NEO-334: may this row be retitled `next`? A variant type's title is its
 * kind (`variantRole.ts`), so a rename that changes the kind would silently
 * change what every row beneath it is. This gathers the facts
 * `variantTypeRenameOutcome` decides on and returns its answer without
 * throwing, for the doors that collect refusals rather than throw
 * (`applySelectorSyncSuggestions`, the suggestions query, the
 * reconciliation store's title edit).
 *
 * Any row that is not a `variantType` is `{ ok: true }` with no reads. Reads
 * only what the answer needs, every one of them `.first()` or a single
 * parent's children:
 *
 *   - kind unchanged and not becoming Base: nothing.
 *   - becoming Base: the set's variant types (one `by_level_and_parent`
 *     page, a handful of rows) for another Base.
 *   - kind changes: one `.first()` child (`by_parent`), one `.first()` card
 *     printed on the type and one `.first()` card cross-listed into it
 *     (both `by_selector_option`); and, from an Insert type, the type's
 *     inserts with a `.first()` sub-variant each, stopping at the first.
 */
export async function variantTypeRenameCheck(
  ctx: Pick<QueryCtx, "db">,
  row: RenameGuardRow,
  next: string,
): Promise<VariantTypeRenameOutcome> {
  if (row.level !== "variantType") return { ok: true };
  const current = row.value ?? "";
  const from = variantTypeKindFromTitle(current);
  const to = variantTypeKindFromTitle(next);
  if (from === to && to !== "base") return { ok: true };

  let siblingBase = false;
  if (to === "base" && from !== "base" && row.parentId) {
    const siblings = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "variantType").eq("parentId", row.parentId),
      )
      .collect();
    siblingBase = siblings.some(
      (s) => s._id !== row._id && variantTypeKind(s) === "base",
    );
  }
  if (from === to) {
    return variantTypeRenameOutcome(current, next, {
      hasRowsBeneath: false,
      subVariants: 0,
      cards: 0,
      siblingBase,
    });
  }

  const child = await ctx.db
    .query("selectorOptions")
    .withIndex("by_parent", (q) => q.eq("parentId", row._id))
    .first();
  const printed = await ctx.db
    .query("cardChecklist")
    .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", row._id))
    .first();
  const crossListed = printed
    ? null
    : await ctx.db
        .query("cardCrossListings")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", row._id),
        )
        .first();
  const cards = printed || crossListed ? 1 : 0;

  let subVariants = 0;
  if (from === "insert" && child) {
    const inserts = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "insert").eq("parentId", row._id),
      )
      .collect();
    for (const insert of inserts) {
      const sub = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "parallel").eq("parentId", insert._id),
        )
        .first();
      if (sub) {
        subVariants = 1;
        break;
      }
    }
  }

  return variantTypeRenameOutcome(current, next, {
    hasRowsBeneath: child !== null || cards > 0,
    subVariants,
    cards,
    siblingBase,
  });
}

/**
 * NEO-334: the throwing form of `variantTypeRenameCheck`, for
 * `renameSelectorOption`. Run BEFORE `planValueRename`, so a refused rename
 * writes nothing. Throws `ConvexError({ code: VARIANT_TYPE_RENAME_REFUSED,
 * message })`, the payload `RenameEntityControl` already renders.
 */
export async function assertVariantTypeRenameAllowed(
  ctx: Pick<QueryCtx, "db">,
  row: RenameGuardRow,
  next: string,
): Promise<void> {
  const outcome = await variantTypeRenameCheck(ctx, row, next);
  if (outcome.ok) return;
  throw new ConvexError({ code: outcome.code, message: outcome.message });
}
