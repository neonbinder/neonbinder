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
 */

import type { Id } from "../_generated/dataModel";

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

/** A year-shaped string, or undefined. Never NaN. */
function parseYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
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
