/**
 * NEO-308 — a Group Parallels plan, cut into transactions the server accepts.
 *
 * ## Why this exists
 *
 * `applyParallelGroupings` refuses more than `MAX_PARALLEL_GROUPING_ENTRIES`
 * entries in one call (NEO-296: one transaction's read/write budget). The
 * modal used to send its whole plan in one call, so a big enough session
 * could only ever be refused — "Save in smaller batches" to an operator with
 * no way to do that but closing the dialog and redoing part of the work.
 *
 * The ruling (Jason): no all-or-nothing wrapper. The client splits the plan
 * into chunks of at most the cap, sends them one after another, and each
 * chunk is validated and applied WHOLE by the mutation. A save that stops
 * part way leaves every earlier chunk applied and a well-formed tree: the
 * modal rebuilds from it and the operator carries on from there.
 *
 * Env-free and import-free on purpose (a type import aside): Vite bundles it
 * into the modal, so it must not reach `selectorOptions.ts` or anything that
 * reads `process.env`. The server imports the cap FROM here, so the two can
 * never disagree about it.
 *
 * ## The order: demotions → reparentings → promotions
 *
 * Within one call the handler validates every entry against the tree "as it
 * will be after this plan" (demotions are read first, targets are judged
 * against them, departures are subtracted before a parallel count). Split
 * across calls, an entry in chunk k sees the tree as the earlier chunks LEFT
 * it, plus its own chunk's plan. Flattening the classes in this order is
 * enough for every check the handler makes to reach the same verdict on a
 * plan the modal can produce, because each check only ever needs a
 * departure or a demotion to have happened no LATER than the entry that
 * depends on it:
 *
 * - An arrival (reparenting or promotion) whose target the plan demotes:
 *   `checkTarget` accepts a target demoted in the same call, and a target
 *   demoted in an earlier call is by then an insert under this variant type.
 *   Demotions go first, so the demotion is never in a LATER call.
 * - A promoted insert must hold no parallels after the plan
 *   (`hasParallels`). Its parallels leave by demotion or reparenting — both
 *   earlier classes — so each has either committed or is in the same call,
 *   where `leavingParent` discounts it.
 * - A demotion checks that its row's parent is still an insert of this
 *   variant type. If the plan also promotes that parent, the demotion must
 *   commit first; the parent's promotion is in a later class.
 * - The duplicate-parallel guard compares each arrival with the parallels
 *   that will be under the target. A row that left in an earlier call is
 *   gone from the target by then, and one that arrived in an earlier call is
 *   there to be compared with — the same set the single call built in
 *   memory. Departures by demotion always precede arrivals; departures by
 *   reparenting precede every promotion.
 *
 * ## Where a split plan CAN differ from one call
 *
 * One case, and it is a refusal, not a bad tree: two parallels that
 * `indistinguishableByMarketplaceIds` calls twins, A under insert T and B
 * elsewhere, where the plan reparents A away from T and B onto T. In one call
 * A is discounted as leaving; if B's reparenting falls in an earlier chunk
 * than A's, A is still under T when B arrives, and chunk k is refused as a
 * duplicate while chunks before it stay applied. The modal lists reparentings
 * in tree order, so this needs a plan past the cap AND twins moving past each
 * other in the wrong order. Recovery is the normal one: the modal rebuilds
 * from what landed, and the moves that are left are re-done in a smaller save
 * that fits one call, where the guard sees both moves together.
 *
 * Plans the modal never builds (it emits one entry per row, and a row's class
 * follows what it was at open) can also land differently, but never as a
 * parallel of a parallel:
 *
 * - A `chain` (a target the plan itself promotes or reparents) is refused
 *   only when both entries share a call. Split, the later entry meets the
 *   earlier one's result instead: a promotion of an insert that has just
 *   received a parallel is refused `hasParallels`; an arrival at a row that
 *   is already a parallel is refused `notAnInsert`.
 * - `twoMoves` (one row demoted AND reparented) likewise: once the demotion
 *   has committed, the reparenting finds an insert and is refused `moved`.
 * - A row both demoted and PROMOTED is refused in one call (the promotion
 *   finds a parallel). Split, the demotion commits and the promotion then
 *   finds an insert and applies: the row ends a parallel of the promotion's
 *   target — one level deep, and a move the plan did name.
 *
 * Each list is de-duplicated by the row it moves first (see
 * `chunkGroupingPlan`), which the handler's per-row Maps do inside one call
 * but cannot do across two.
 */
import type { Id } from "./_generated/dataModel";

/**
 * NEO-296 — how many entries ONE `applyParallelGroupings` call may carry.
 * The arithmetic behind the number sits on the mutation, beside the check
 * that enforces it.
 */
export const MAX_PARALLEL_GROUPING_ENTRIES = 200;

/** The three argument lists of `applyParallelGroupings`, as the modal diffs them. */
export type GroupingPlan = {
  promotions: Array<{
    insertId: Id<"selectorOptions">;
    targetInsertId: Id<"selectorOptions">;
  }>;
  demotions: Array<{ parallelId: Id<"selectorOptions"> }>;
  reparentings: Array<{
    parallelId: Id<"selectorOptions">;
    newInsertId: Id<"selectorOptions">;
  }>;
};

/**
 * One entry per row moved, the last entry for a row winning — at the
 * position of that row's FIRST entry, which is exactly what the handler's
 * `Map.set` does to its own lists. (The handler's one deviation: a
 * reparenting onto the row's current parent is skipped before it reaches
 * the Map, so a later no-op does not undo an earlier real move there. The
 * modal never sends a no-op for a row it also moves.)
 */
function lastPerRow<T>(entries: T[], rowOf: (entry: T) => string): T[] {
  const byRow = new Map<string, T>();
  for (const entry of entries) byRow.set(rowOf(entry), entry);
  return [...byRow.values()];
}

type Entry =
  | { kind: "demotion"; entry: GroupingPlan["demotions"][number] }
  | { kind: "reparenting"; entry: GroupingPlan["reparentings"][number] }
  | { kind: "promotion"; entry: GroupingPlan["promotions"][number] };

/**
 * Cut `plan` into calls of at most `limit` entries each, in the order they
 * must be sent: every demotion, then every reparenting, then every promotion
 * (see the module comment for why that order), stable within each class.
 *
 * Pure and deterministic. Every chunk carries all three lists, possibly
 * empty; an empty plan is no calls at all.
 */
export function chunkGroupingPlan(
  plan: GroupingPlan,
  limit = MAX_PARALLEL_GROUPING_ENTRIES,
): GroupingPlan[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`chunkGroupingPlan: limit must be a positive integer`);
  }
  const flat: Entry[] = [
    ...lastPerRow(plan.demotions, (d) => d.parallelId).map(
      (entry): Entry => ({ kind: "demotion", entry }),
    ),
    ...lastPerRow(plan.reparentings, (r) => r.parallelId).map(
      (entry): Entry => ({ kind: "reparenting", entry }),
    ),
    ...lastPerRow(plan.promotions, (p) => p.insertId).map(
      (entry): Entry => ({ kind: "promotion", entry }),
    ),
  ];

  const chunks: GroupingPlan[] = [];
  for (let start = 0; start < flat.length; start += limit) {
    const chunk: GroupingPlan = {
      promotions: [],
      demotions: [],
      reparentings: [],
    };
    for (const item of flat.slice(start, start + limit)) {
      if (item.kind === "demotion") chunk.demotions.push(item.entry);
      else if (item.kind === "reparenting") chunk.reparentings.push(item.entry);
      else chunk.promotions.push(item.entry);
    }
    chunks.push(chunk);
  }
  return chunks;
}
