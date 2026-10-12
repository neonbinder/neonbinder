/**
 * NEO-339 — Group Parallels for one variant type, the way the dialog does it
 * (`ParallelGroupingModal`).
 *
 * The dialog opens on `getInsertTreeByVariantType`, builds its state with
 * `buildInitialState`, moves rows through `groupingReducer`, diffs with
 * `computeDiff`, cuts the diff with `chunkGroupingPlan` and sends the chunks
 * to `applyParallelGroupings` one after another (NEO-308). This module runs
 * the same functions (`lib/set-build/grouping.ts`), with the spec's `group`
 * entries in place of the drags and with NO prefix suggestions: a spec names
 * every move it wants, and a row it does not name stays where it is.
 *
 * Refs. Every `RowRef` is resolved exactly once, against the tree as it
 * stands before any move: an NB name through `pickExactlyOne`, a marketplace
 * id through the rows' platform slots. Zero or several matches is an open
 * name; nothing is picked by position.
 *
 * Open decisions (nothing is written while any is open):
 *  - a named insert that is itself a parallel (`parent-is-parallel`);
 *  - a named parallel that holds parallels of its own (`child-holds-parallels`);
 *  - a row named both as an insert and as a parallel (`chain`);
 *  - a row named as a parallel twice (`named-twice`), or of itself (`self`).
 *
 * Idempotent: a parallel already under its named insert is not moved, and a
 * diff with nothing in it writes nothing (`skipped`). A chunk the server
 * refuses ends the step as an open `refused` decision that says what landed;
 * the earlier chunks stay applied (Jason's NEO-308 ruling) and a re-run reads
 * the tree again and carries on from there.
 */

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { chunkGroupingPlan, type GroupingPlan } from "../../../convex/parallelGroupingPlan";
import { slotIds } from "../../../convex/platformSlots";
import {
  buildInitialState,
  computeDiff,
  emptyGroupingState,
  groupingReducer,
  type GroupingState,
  type RowId,
} from "../../../lib/set-build/grouping";
import type { NbClient } from "../client/convex-client";
import { ResolveError, type OpenGrouping, type OpenName } from "../service";
import type { Group, RowRef } from "../spec/schema";
import { pickExactlyOne } from "../spec/resolve";

export type InsertTree = FunctionReturnType<typeof api.selectorOptions.getInsertTreeByVariantType>;
type TreeRow = InsertTree[number]["insert"];

export interface GroupContext {
  /** Where the `group` block sits in the spec, e.g. `steps[0].variants[1]`. */
  at: string;
  /** `formatPath` of the set. */
  path: string;
  /** The variant type's title as the spec names it. */
  type: string;
}

/** A fill-in for the template: the ref at `at` replaced by `value`. */
export interface GroupFill {
  at: string;
  value: string;
}

export interface GroupOpen {
  outcome: "open";
  names: OpenName[];
  grouping: OpenGrouping[];
  fills: GroupFill[];
}

export type GroupPlan =
  | { outcome: "done"; ungrouped: number }
  | { outcome: "todo"; diff: GroupingPlan; chunks: GroupingPlan[]; moves: number; ungrouped: number }
  | GroupOpen;

export type GroupOutcome =
  | { outcome: "skipped"; ungrouped: number }
  | { outcome: "grouped"; moved: number; saves: number; ungrouped: number }
  | GroupOpen;

/** `{ bsc: "x" }` → `BSC x`; a name as it is. For messages. */
export function describeRef(ref: RowRef): string {
  if (typeof ref === "string") return `"${ref}"`;
  return "bsc" in ref ? `BSC ${ref.bsc}` : `SportLots ${ref.sportlots}`;
}

/** Top-level rows that hold no parallels, in a reducer state. */
function ungroupedIn(state: GroupingState): number {
  const parents = new Set<RowId>();
  for (const p of state.placement.values()) if (p.kind === "child") parents.add(p.parentId);
  let n = 0;
  for (const [id, p] of state.placement) if (p.kind === "ungrouped" && !parents.has(id)) n++;
  return n;
}

/** Top-level rows that hold no parallels, in a tree as the server returns it. */
export function ungroupedInTree(tree: InsertTree): number {
  return tree.filter((t) => t.parallels.length === 0).length;
}

/**
 * The one row `ref` names among `rows` (the type's inserts and their
 * parallels), or a `ResolveError` listing every candidate.
 */
function resolveRef(rows: readonly TreeRow[], parentName: ReadonlyMap<string, string>, ref: RowRef, at: string): TreeRow {
  const detailOf = (r: TreeRow) => {
    const parent = parentName.get(r._id);
    return parent ? `parallel of ${parent}` : "insert";
  };
  if (typeof ref === "string") return pickExactlyOne(rows, ref, "row", at, detailOf);
  const side = "bsc" in ref ? "bsc" : "sportlots";
  const id = "bsc" in ref ? ref.bsc : ref.sportlots;
  const matches = rows.filter((r) => slotIds(r, side).includes(id));
  if (matches.length === 1) return matches[0];
  const kind = side === "bsc" ? "BSC id" : "SportLots id";
  throw new ResolveError({
    kind,
    query: id,
    at,
    candidates: matches.map((r) => ({ id: String(r._id), name: r.value, detail: detailOf(r) })),
    message:
      matches.length === 0
        ? `No row of this type holds ${kind} ${id}.`
        : `${kind} ${id} is held by ${matches.length} rows of this type; name exactly one by its NB name.`,
  });
}

/**
 * What the grouping would do, without writing: resolve every ref, check the
 * entries, run the moves through the reducer, and diff. Read-only (one query).
 */
export async function planGrouping(
  client: NbClient,
  variantTypeId: RowId,
  group: Group,
  ctx: GroupContext,
): Promise<GroupPlan> {
  const tree = await client.query(api.selectorOptions.getInsertTreeByVariantType, { variantTypeId });
  const rows: TreeRow[] = [];
  const parentName = new Map<string, string>();
  for (const { insert, parallels } of tree) {
    rows.push(insert);
    for (const p of parallels) {
      rows.push(p);
      parentName.set(p._id, insert.value);
    }
  }
  const nameOf = (id: RowId) => rows.find((r) => r._id === id)?.value ?? String(id);

  // 1. Resolve every ref once, against the tree before any move.
  const names: OpenName[] = [];
  const fills: GroupFill[] = [];
  const resolve = (ref: RowRef, at: string): RowId | undefined => {
    try {
      return resolveRef(rows, parentName, ref, at)._id;
    } catch (err) {
      if (!(err instanceof ResolveError)) throw err;
      names.push({ at, kind: err.kind, name: err.query, candidates: err.candidates });
      fills.push({
        at,
        value: `<one of: ${err.candidates.map((c) => c.name).join(" | ") || "(no candidates — check the name or id)"}>`,
      });
      return undefined;
    }
  };
  const base = `${ctx.at}.group.parents`;
  const entries = group.parents.map((p, pi) => ({
    parent: resolve(p.insert, `${base}[${pi}].insert`),
    parentAt: `${base}[${pi}].insert`,
    children: p.parallels.map((c, ci) => ({ id: resolve(c, `${base}[${pi}].parallels[${ci}]`), at: `${base}[${pi}].parallels[${ci}]` })),
  }));
  if (names.length > 0) return { outcome: "open", names, grouping: [], fills };

  // 2. Check the entries the way the dialog's rules would judge them.
  const init = buildInitialState(tree, { suggest: false });
  const grouping: OpenGrouping[] = [];
  const problem = (at: string, kind: OpenGrouping["problem"], id: RowId, detail: string) => {
    grouping.push({ at, path: ctx.path, type: ctx.type, problem: kind, name: nameOf(id), detail });
    fills.push({ at, value: `<${detail} Name another row.>` });
  };
  const namedAsChild = new Map<RowId, number>();
  for (const e of entries) for (const c of e.children) namedAsChild.set(c.id!, (namedAsChild.get(c.id!) ?? 0) + 1);
  const seenChild = new Set<RowId>();
  for (const e of entries) {
    const parent = e.parent!;
    const info = init.rows.get(parent)!;
    if (info.originalKind === "parallel") {
      problem(e.parentAt, "parent-is-parallel", parent, `"${info.value}" is a parallel of "${nameOf(info.originalParentId!)}", so nothing can be grouped under it.`);
    } else if (namedAsChild.has(parent)) {
      problem(e.parentAt, "chain", parent, `"${info.value}" is named as an insert and as a parallel; a parallel cannot hold parallels.`);
    }
    for (const c of e.children) {
      const id = c.id!;
      const child = init.rows.get(id)!;
      if (id === parent) {
        problem(c.at, "self", id, `"${child.value}" is named as a parallel of itself.`);
      } else if (seenChild.has(id)) {
        problem(c.at, "named-twice", id, `"${child.value}" is named as a parallel more than once.`);
      } else if (child.originalKind === "insert" && child.originalHadParallels) {
        problem(c.at, "child-holds-parallels", id, `"${child.value}" holds parallels of its own, so it cannot become one.`);
      }
      seenChild.add(id);
    }
  }
  if (grouping.length > 0) return { outcome: "open", names: [], grouping, fills };

  // 3. The moves, through the dialog's reducer. A parallel already under its
  //    named insert is not moved.
  let state = groupingReducer(emptyGroupingState, { type: "INIT", ...init });
  for (const e of entries) {
    const parent = e.parent!;
    const rowIds = e.children
      .map((c) => c.id!)
      .filter((id) => {
        const info = state.rows.get(id)!;
        return !(info.originalKind === "parallel" && info.originalParentId === parent);
      });
    if (rowIds.length === 0) continue;
    const next = groupingReducer(state, {
      type: "MOVE",
      rowIds,
      placement: { kind: "child", parentId: parent },
      fromSelection: false,
    });
    if (next === state) {
      // The prechecks above mirror every rule the reducer enforces, so this is
      // a backstop: report it rather than send a partial plan.
      grouping.push({
        at: e.parentAt,
        path: ctx.path,
        type: ctx.type,
        problem: "refused",
        name: nameOf(parent),
        detail: `the Group Parallels rules refuse moving ${rowIds.map(nameOf).join(", ")} under "${nameOf(parent)}".`,
      });
      continue;
    }
    state = next;
  }
  if (grouping.length > 0) return { outcome: "open", names: [], grouping, fills };

  const diff = computeDiff(state);
  const moves = diff.promotions.length + diff.demotions.length + diff.reparentings.length;
  if (moves === 0) return { outcome: "done", ungrouped: ungroupedIn(state) };
  return { outcome: "todo", diff, chunks: chunkGroupingPlan(diff), moves, ungrouped: ungroupedIn(state) };
}

/** The sentence a refused save carries: a ConvexError's string, else the message's first line. */
function refusalOf(err: unknown): string {
  const data = (err as { data?: unknown } | null)?.data;
  if (typeof data === "string") return data;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0];
}

/**
 * Group the type's rows as `group` says. Writes (one `applyParallelGroupings`
 * per chunk, sequentially); the caller has checked the confirm phrase. On
 * `readOnlyClient` the first chunk throws `PlanWouldWrite`, which is left to
 * the caller.
 */
export async function groupParallels(
  client: NbClient,
  variantTypeId: RowId,
  group: Group,
  ctx: GroupContext,
): Promise<GroupOutcome> {
  const plan = await planGrouping(client, variantTypeId, group, ctx);
  if (plan.outcome === "open") return plan;
  if (plan.outcome === "done") return { outcome: "skipped", ungrouped: plan.ungrouped };

  let landed = 0;
  let moved = 0;
  for (const chunk of plan.chunks) {
    try {
      const r = await client.mutation(api.selectorOptions.applyParallelGroupings, { variantTypeId, ...chunk });
      moved += r.promoted + r.demoted + r.reparented;
      landed += 1;
    } catch (err) {
      if (err instanceof Error && err.name === "PlanWouldWrite") throw err;
      const detail =
        `the server refused save ${landed + 1} of ${plan.chunks.length}: ${refusalOf(err)} ` +
        (landed > 0
          ? `${landed} earlier save${landed === 1 ? "" : "s"} landed (${moved} row${moved === 1 ? "" : "s"} moved) and stay; run again to carry on from there.`
          : "Nothing was moved.");
      return {
        outcome: "open",
        names: [],
        grouping: [{ at: `${ctx.at}.group`, path: ctx.path, type: ctx.type, problem: "refused", name: ctx.type, detail }],
        fills: [],
      };
    }
  }
  const after = await client.query(api.selectorOptions.getInsertTreeByVariantType, { variantTypeId });
  return { outcome: "grouped", moved, saves: landed, ungrouped: ungroupedInTree(after) };
}
