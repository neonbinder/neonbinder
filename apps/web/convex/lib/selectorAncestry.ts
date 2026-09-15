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
