/**
 * NEO-306 — "Make insert of…": the operator door that files a row SportLots
 * (or the Parallels reconcile, or the SportLots-only review) put in the
 * wrong place as an INSERT of a set, or as a PARALLEL of one of its inserts.
 * The sibling of NEO-305's "Make parallel of…" (`setParallelConversion.ts`);
 * both are built on `setShapeMove.ts`, which carries the invariants: keyed by
 * id, a link is never dropped, cards follow their own slot, card numbers are
 * never assumed unique, never guess.
 *
 * ## Sources
 *
 *  - S1, a set: a set that is nothing but a Base carrying no BSC link
 *    (`readConversionSource`, the same guards "Make parallel of…" uses).
 *    The Base and the set are emptied and deleted.
 *  - S2, a row: an `insert`-level row under a variant type of any role,
 *    carrying no BSC link and with nothing under it. It is emptied and
 *    deleted.
 *
 * A marketplace link is not required on either: a row with no marketplace
 * ids behaves exactly like one with them (product invariant 6). A BSC link
 * holds a row where it is, because BSC's own hierarchy put it there.
 *
 * ## Landings (the `landing` argument)
 *
 *  - `newInsert` — a new insert under the target set's Insert type, named
 *    from the label with the target set's name taken off the front.
 *  - `joinInsert` — onto an existing insert.
 *  - `newParallel` — a new parallel under an existing insert, named from the
 *    label with the set's name and then the insert's name taken off.
 *  - `joinParallel` — onto an existing parallel of an insert.
 *  - `newInsertNamed` — the operator types the insert's name; the insert is
 *    created with no links and the source becomes a new parallel of it.
 *
 * "New insert and a new parallel under it" is never derived: NB would have to
 * guess where a label splits. The operator types the insert instead.
 *
 * ## There are no NB-created Insert types
 *
 * The target's Insert type is found by its NB role (`variantTypeRole`), never
 * by its name, and a set with none is refused with a sentence that names the
 * fix (run Sync Variant Types) — v3 of the plan.
 *
 * ## The link-taken rule, one level deeper than NEO-305
 *
 * Every landing is refused when ANY insert under the target Insert type, or
 * any parallel under those inserts, already holds one of the moving
 * SportLots ids: the id would end up on two rows of one set. The source's own
 * rows are not holders — they are what moves.
 *
 * ## Copy
 *
 * Every refusal is a `ConvexError` carrying one operator sentence
 * (`insertConversionRefusal`). NB names only. DRAFT copy pending Jason's
 * sign-off (NEO-245: no copywriter agent).
 */

import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";
import { inheritedTeamIds } from "./lib/selectorTeams";
import { allocateSlots, initialSlots, slotIds } from "./platformSlots";
import { deleteEmptySelectorOptionRow } from "./selectorOptions";
import {
  checkCustomSelectorValue,
  matchesBrandPrefix,
  selectorValueKey,
} from "./selectorSyncMatch";
import { unionChildren } from "./selectorSyncStore";
import {
  MAX_CARDS_PER_MOVE,
  MAX_CROSS_LISTINGS_PER_MOVE,
  MAX_TARGET_SETS,
  cardsOn,
  childrenOf,
  hasOpenReview,
  linksOnRows,
  lossFieldNames,
  lossOnto,
  lossValidator,
  moveCards,
  moveGuestCrossListings,
  nameAfterPrefixes,
  namingLabel,
  readConversionSource,
  sourceDataOf,
  sourceDataOfRow,
  targetNamePrefixes,
  type ConversionLoss,
  type ConversionSourceRefusals,
  type MovingLink,
  type SourceData,
} from "./setShapeMove";
import { derivedVariantFlags, variantTypeRole } from "./variantRole";

type Row = Doc<"selectorOptions">;
type RowId = Id<"selectorOptions">;

// ───────────────────────────────────────────────────────────────────────────
// Bounds
// ───────────────────────────────────────────────────────────────────────────

/** Inserts one Insert type lists in the dialog. */
export const MAX_TARGET_INSERTS = 500;

/**
 * Rows the link-taken check reads under one Insert type: its inserts plus
 * every parallel under them. The rule cannot be judged on a partial read, so
 * past this the move refuses (fail closed) rather than risk one SportLots id
 * on two rows. Each insert's parallels are one indexed read; this bounds the
 * document volume, well inside a transaction's budget.
 */
export const MAX_INSERT_TREE_ROWS = 2000;

// ───────────────────────────────────────────────────────────────────────────
// Operator sentences (DRAFT — pending Jason's sign-off)
// ───────────────────────────────────────────────────────────────────────────

export const insertConversionRefusal = {
  rowGone: () => "That row is gone. Refresh and try again.",
  notEligible: () => "Only a set, or an insert or parallel of one, can become an insert.",
  onBsc: (set: string) => `BSC lists “${set}” as a set, so it stays a set.`,
  onBscRow: (row: string) => `BSC lists “${row}” where it is, so it stays there.`,
  noBase: (set: string) => `“${set}” has no Base to move.`,
  moreThanBase: (set: string) =>
    `“${set}” has more than a Base under it. Clear out its other variant types first.`,
  baseHasRows: (set: string) =>
    `“${set}”’s Base has inserts or parallels under it. Move them out first.`,
  hasChildren: (row: string) => `“${row}” has parallels under it. Move them out first.`,
  reviewOpen: (row: string) =>
    `A checklist review is open on “${row}”. Finish it, then try again.`,
  targetGone: () => "That set is gone. Refresh and try again.",
  insertTypeGone: () => "That Insert type is gone. Refresh and try again.",
  self: (row: string) => `“${row}” can't be an insert of itself.`,
  otherBrand: (target: string, brand: string) =>
    `“${target}” is under a different brand. Pick one of ${brand}’s sets.`,
  notInsertType: (type: string, target: string) =>
    `“${type}” under “${target}” isn't an Insert type. Pick ${target}’s Insert.`,
  noInsertTypeYet: (target: string) =>
    `${target} has no Insert type yet. Pick ${target}, run Sync Variant Types, then come back.`,
  insertGone: () => "That insert moved. Refresh and try again.",
  parallelGone: () => "That parallel moved. Refresh and try again.",
  alreadyThere: (row: string, target: string) =>
    `“${row}” is already one of ${target}’s inserts.`,
  ownName: (label: string, target: string) =>
    `“${label}” is ${target}’s own name, so it can't be a new insert of it. Add it to an existing insert instead.`,
  insertNameTaken: (target: string, name: string) =>
    `${target} already has a “${name}” insert. Add it to that one instead.`,
  parallelNameTaken: (insert: string, name: string) =>
    `“${insert}” already has a “${name}” parallel. Add it to that one instead.`,
  insertOwnName: (label: string, insert: string) =>
    `“${label}” is “${insert}”’s own name, so add it to “${insert}” itself.`,
  wholeName: (label: string) =>
    `“${label}” is the whole of that name — pick New insert instead.`,
  linkTaken: (holder: string, target: string, row: string) =>
    `“${holder}” under ${target} already has this SportLots link. Remove it from “${holder}” first if “${row}” is the one to keep.`,
  badName: (reason: string) => `That name won't work: ${reason}.`,
  tooManyCards: (row: string, max: number) =>
    `“${row}” holds more than ${max.toLocaleString("en-US")} cards — more than one move can carry. Nothing changed.`,
  tooManyGuests: (row: string, max: number) =>
    `“${row}” has more than ${max} cards from other sets listed in it — more than one move can carry. Nothing changed.`,
  tooManyRows: (target: string) =>
    `${target}’s inserts hold too many rows to check this move against. Nothing changed.`,
};

/** S1's guards, refused in this door's words. */
const setSourceRefusals: ConversionSourceRefusals = {
  setGone: insertConversionRefusal.rowGone,
  notASet: insertConversionRefusal.notEligible,
  onBsc: insertConversionRefusal.onBsc,
  noBase: insertConversionRefusal.noBase,
  moreThanBase: insertConversionRefusal.moreThanBase,
  baseHasRows: insertConversionRefusal.baseHasRows,
};

// ───────────────────────────────────────────────────────────────────────────
// Source
// ───────────────────────────────────────────────────────────────────────────

type InsertSource = {
  /** "set" = S1 (a set and its Base), "row" = S2 (one insert-level row). */
  kind: "set" | "row";
  /** The row the operator acted on: the set (S1) or the row (S2). */
  row: Row;
  /** Every row the move empties and deletes, child first. */
  rows: Row[];
  brand: Row;
  /** S2 only: the set the row sits under now. */
  ownSet: Row | null;
  /** The label new rows are named from. */
  label: string;
  /** Operator-typed data the move carries onto a new row. */
  data: SourceData;
};

type Refused = { ok: false; reason: string };

/**
 * Every guard that depends on the source alone — the ones the row action is
 * shown or hidden by. The review, card and cross-listing checks are the
 * mutation's.
 */
async function readInsertConversionSource(
  ctx: { db: QueryCtx["db"] },
  rowId: RowId,
): Promise<Refused | ({ ok: true } & InsertSource)> {
  const row = await ctx.db.get(rowId);
  if (!row) return { ok: false, reason: insertConversionRefusal.rowGone() };

  if (row.level === "setName") {
    const s1 = await readConversionSource(ctx, rowId, setSourceRefusals);
    if (!s1.ok) return s1;
    const rows = [s1.base, s1.set];
    return {
      ok: true,
      kind: "set",
      row: s1.set,
      rows,
      brand: s1.brand,
      ownSet: null,
      label: namingLabel(rows, s1.set.value),
      data: sourceDataOf(s1.set, s1.base),
    };
  }

  const notEligible: Refused = { ok: false, reason: insertConversionRefusal.notEligible() };
  if (row.level !== "insert") return notEligible;
  const type = row.parentId ? await ctx.db.get(row.parentId) : null;
  if (!type || type.level !== "variantType") return notEligible;
  const set = type.parentId ? await ctx.db.get(type.parentId) : null;
  const brand = set?.parentId ? await ctx.db.get(set.parentId) : null;
  if (!set || set.level !== "setName" || !brand || brand.level !== "manufacturer") {
    return notEligible;
  }
  if (slotIds(row, "bsc").length > 0) {
    return { ok: false, reason: insertConversionRefusal.onBscRow(row.value) };
  }
  if ((await childrenOf(ctx, row._id, 1)).length > 0) {
    return { ok: false, reason: insertConversionRefusal.hasChildren(row.value) };
  }
  return {
    ok: true,
    kind: "row",
    row,
    rows: [row],
    brand,
    ownSet: set,
    label: namingLabel([row], row.value),
    data: sourceDataOfRow(row),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Target
// ───────────────────────────────────────────────────────────────────────────

/** The first variant type under `setId` whose NB role is "insert". Never by name. */
async function insertTypeOf(
  ctx: { db: QueryCtx["db"] },
  setId: RowId,
): Promise<Row | null> {
  const types = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "variantType").eq("parentId", setId),
    )
    .collect();
  return types.find((t) => variantTypeRole(t) === "insert") ?? null;
}

/** A target set the source may move under: a set of its own brand, and (S1) not itself. */
function checkTargetSet(source: InsertSource, targetSet: Row | null): string | null {
  if (!targetSet || targetSet.level !== "setName") return insertConversionRefusal.targetGone();
  if (source.kind === "set" && targetSet._id === source.row._id) {
    return insertConversionRefusal.self(source.row.value);
  }
  // Same brand is same year: a brand row belongs to exactly one year.
  if (targetSet.parentId !== source.brand._id) {
    return insertConversionRefusal.otherBrand(targetSet.value, source.brand.value);
  }
  return null;
}

type Target = { targetSet: Row; insertType: Row };

/** For the queries: the set the operator picked, and its Insert type. */
async function resolveTargetSet(
  ctx: { db: QueryCtx["db"] },
  source: InsertSource,
  targetSetId: RowId,
): Promise<Refused | ({ ok: true } & Target)> {
  const targetSet = await ctx.db.get(targetSetId);
  const refusal = checkTargetSet(source, targetSet);
  if (refusal) return { ok: false, reason: refusal };
  const insertType = await insertTypeOf(ctx, targetSet!._id);
  if (!insertType) {
    return { ok: false, reason: insertConversionRefusal.noInsertTypeYet(targetSet!.value) };
  }
  return { ok: true, targetSet: targetSet!, insertType };
}

/** For the mutation: the Insert type the client sent, re-checked by role. */
async function resolveTargetType(
  ctx: { db: QueryCtx["db"] },
  source: InsertSource,
  insertTypeId: RowId,
): Promise<Refused | ({ ok: true } & Target)> {
  const insertType = await ctx.db.get(insertTypeId);
  if (!insertType || insertType.level !== "variantType" || !insertType.parentId) {
    return { ok: false, reason: insertConversionRefusal.insertTypeGone() };
  }
  const targetSet = await ctx.db.get(insertType.parentId);
  const refusal = checkTargetSet(source, targetSet);
  if (refusal) return { ok: false, reason: refusal };
  if (variantTypeRole(insertType) !== "insert") {
    return {
      ok: false,
      reason: insertConversionRefusal.notInsertType(insertType.value, targetSet!.value),
    };
  }
  return { ok: true, targetSet: targetSet!, insertType };
}

// ───────────────────────────────────────────────────────────────────────────
// The Insert type's rows, and the link-taken rule
// ───────────────────────────────────────────────────────────────────────────

type InsertTree = {
  inserts: Row[];
  parallelsOf: Map<RowId, Row[]>;
  /** The read stopped at `MAX_INSERT_TREE_ROWS`: nothing is judged on it. */
  truncated: boolean;
};

async function readInsertTree(
  ctx: { db: QueryCtx["db"] },
  insertTypeId: RowId,
): Promise<InsertTree> {
  const inserts = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "insert").eq("parentId", insertTypeId),
    )
    .take(MAX_INSERT_TREE_ROWS + 1);
  const parallelsOf = new Map<RowId, Row[]>();
  if (inserts.length > MAX_INSERT_TREE_ROWS) {
    return { inserts: inserts.slice(0, MAX_INSERT_TREE_ROWS), parallelsOf, truncated: true };
  }
  let read = inserts.length;
  for (const insert of inserts) {
    const remaining = MAX_INSERT_TREE_ROWS - read;
    const parallels = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "parallel").eq("parentId", insert._id),
      )
      .take(remaining + 1);
    if (parallels.length > remaining) return { inserts, parallelsOf, truncated: true };
    read += parallels.length;
    parallelsOf.set(insert._id, parallels);
  }
  return { inserts, parallelsOf, truncated: false };
}

/** The moving SportLots ids. */
function movingIds(source: InsertSource): Set<string> {
  return new Set(linksOnRows(source.rows).map((l) => l.id));
}

function holdsMoving(row: Row, moving: ReadonlySet<string>): boolean {
  return slotIds(row, "sportlots").some((id) => moving.has(id));
}

/**
 * The first row under the Insert type, other than the source's own, holding
 * a moving id — named the way an operator knows it ("Autos" or
 * "Autos Red Ink" for a parallel of an insert).
 */
function holderIn(
  tree: InsertTree,
  source: InsertSource,
): { row: Row; name: string } | null {
  const moving = movingIds(source);
  if (moving.size === 0) return null;
  const own = new Set<string>(source.rows.map((r) => r._id));
  for (const insert of tree.inserts) {
    if (!own.has(insert._id) && holdsMoving(insert, moving)) {
      return { row: insert, name: insert.value };
    }
    for (const parallel of tree.parallelsOf.get(insert._id) ?? []) {
      if (!own.has(parallel._id) && holdsMoving(parallel, moving)) {
        return { row: parallel, name: `${insert.value} ${parallel.value}` };
      }
    }
  }
  return null;
}

/** Why no landing under this Insert type is allowed, when none is. */
function treeBlock(tree: InsertTree, source: InsertSource, targetSet: Row): string | null {
  if (tree.truncated) return insertConversionRefusal.tooManyRows(targetSet.value);
  const holder = holderIn(tree, source);
  if (holder) {
    return insertConversionRefusal.linkTaken(holder.name, targetSet.value, source.row.value);
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Names (derived once, at creation; never re-read)
// ───────────────────────────────────────────────────────────────────────────

function targetPrefixes(source: InsertSource, targetSet: Row): string[] {
  return targetNamePrefixes(targetSet.value, source.brand.metadata?.setNamePrefix);
}

type NewInsertCheck =
  | { ok: true; name: string }
  | { ok: false; reason: string; name?: string; sameAsInsertId?: RowId };

/** A new insert from the label: the target set's name taken off the front. */
function newInsertCheck(
  source: InsertSource,
  targetSet: Row,
  inserts: ReadonlyArray<Row>,
): NewInsertCheck {
  const derived = nameAfterPrefixes(source.label, targetPrefixes(source, targetSet));
  if (derived === null) {
    return { ok: false, reason: insertConversionRefusal.ownName(source.label, targetSet.value) };
  }
  return insertNameCheck(source, targetSet, inserts, derived);
}

/** Validation and the sibling clash, shared by the derived and the typed insert name. */
function insertNameCheck(
  source: InsertSource,
  targetSet: Row,
  inserts: ReadonlyArray<Row>,
  raw: string,
): NewInsertCheck {
  const checked = checkCustomSelectorValue("insert", raw);
  if (!checked.ok) {
    return { ok: false, reason: insertConversionRefusal.badName(checked.reason), name: raw };
  }
  const key = selectorValueKey(checked.value);
  const clash = inserts.find((s) => selectorValueKey(s.value) === key);
  if (clash && clash._id === source.row._id) {
    return {
      ok: false,
      reason: insertConversionRefusal.alreadyThere(source.row.value, targetSet.value),
      name: checked.value,
    };
  }
  if (clash) {
    return {
      ok: false,
      reason: insertConversionRefusal.insertNameTaken(targetSet.value, clash.value),
      name: checked.value,
      sameAsInsertId: clash._id,
    };
  }
  return { ok: true, name: checked.value };
}

type ParallelNameCheck =
  | { ok: true; name: string }
  | {
      ok: false;
      reason: string;
      name?: string;
      /** The label IS the insert's name: join the insert itself. */
      sameAsInsertSelf?: true;
      sameAsParallelId?: RowId;
    };

/**
 * A new parallel's name under `insertValue`: the label with the target set's
 * name taken off (as a new insert's is), then the insert's name. Two steps,
 * in that order, because a label reads "<set> <insert> <parallel>" and a
 * one-pass strip would stop at the set.
 *
 * `whole` names the refusal when nothing is left after the insert's name:
 * `insertOwnName` for an existing insert (join it instead), `wholeName` for a
 * typed one (it IS the label; pick New insert).
 */
function parallelNameCheck(
  source: InsertSource,
  targetSet: Row,
  insertValue: string,
  siblings: ReadonlyArray<Row>,
  whole: "insertOwnName" | "wholeName",
): ParallelNameCheck {
  const afterSet = nameAfterPrefixes(source.label, targetPrefixes(source, targetSet));
  if (afterSet === null) {
    return { ok: false, reason: insertConversionRefusal.ownName(source.label, targetSet.value) };
  }
  const derived = nameAfterPrefixes(afterSet, [insertValue]);
  if (derived === null) {
    return whole === "insertOwnName"
      ? {
          ok: false,
          reason: insertConversionRefusal.insertOwnName(source.label, insertValue),
          sameAsInsertSelf: true,
        }
      : { ok: false, reason: insertConversionRefusal.wholeName(source.label) };
  }
  const checked = checkCustomSelectorValue("parallel", derived);
  if (!checked.ok) {
    return { ok: false, reason: insertConversionRefusal.badName(checked.reason), name: derived };
  }
  const key = selectorValueKey(checked.value);
  const clash = siblings.find((s) => selectorValueKey(s.value) === key);
  if (clash) {
    return {
      ok: false,
      reason: insertConversionRefusal.parallelNameTaken(insertValue, clash.value),
      name: checked.value,
      sameAsParallelId: clash._id,
    };
  }
  return { ok: true, name: checked.value };
}

type NamedCheck =
  | { ok: true; insertName: string; parallelName: string }
  | { ok: false; reason: string; sameAsInsertId?: RowId };

/** "New insert named…": the typed insert, then the source as a new parallel of it. */
function namedCheck(
  source: InsertSource,
  targetSet: Row,
  inserts: ReadonlyArray<Row>,
  raw: string,
): NamedCheck {
  const insert = insertNameCheck(source, targetSet, inserts, raw);
  if (!insert.ok) {
    return {
      ok: false,
      reason: insert.reason,
      ...(insert.sameAsInsertId ? { sameAsInsertId: insert.sameAsInsertId } : {}),
    };
  }
  const parallel = parallelNameCheck(source, targetSet, insert.name, [], "wholeName");
  if (!parallel.ok) return { ok: false, reason: parallel.reason };
  return { ok: true, insertName: insert.name, parallelName: parallel.name };
}

// ───────────────────────────────────────────────────────────────────────────
// Queries behind the dialog
// ───────────────────────────────────────────────────────────────────────────

async function sourceCardCount(
  ctx: { db: QueryCtx["db"] },
  source: InsertSource,
): Promise<number> {
  let total = 0;
  for (const row of source.rows) {
    total += (await cardsOn(ctx, row._id, MAX_CARDS_PER_MOVE + 1)).length;
  }
  return total;
}

/**
 * Whether the "Make insert of…" row action is offered on a row. Only the
 * source-side guards: which target the operator picks is the dialog's
 * question, and the mutation re-checks everything.
 */
export const getMakeInsertEligibility = query({
  args: { rowId: v.id("selectorOptions") },
  returns: v.object({ eligible: v.boolean() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await readInsertConversionSource(ctx, args.rowId);
    return { eligible: source.ok };
  },
});

const targetSetValidator = v.object({
  setId: v.id("selectorOptions"),
  value: v.string(),
  /** Absent when the set has no Insert type yet. */
  insertTypeId: v.optional(v.id("selectorOptions")),
  insertTypeValue: v.optional(v.string()),
});

/**
 * The dialog's first read: the brand's sets, each with its Insert type when
 * it has one, and which to preselect. For a set (S1) the set itself is not a
 * target; for a row (S2) its own set is, and is the default.
 *
 * The preselection is a DISPLAY default — the row's own set, else the set
 * whose name is the longest whole-word prefix of the row's — never a
 * decision the server acts on.
 */
export const getMakeInsertTargets = query({
  args: { rowId: v.id("selectorOptions") },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({
      ok: v.literal(true),
      kind: v.union(v.literal("set"), v.literal("row")),
      rowValue: v.string(),
      brandValue: v.string(),
      /** S2: the set the row sits under now. */
      ownSetId: v.optional(v.id("selectorOptions")),
      ownSetValue: v.optional(v.string()),
      cardCount: v.number(),
      targets: v.array(targetSetValidator),
      suggestedSetId: v.optional(v.id("selectorOptions")),
      truncated: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await readInsertConversionSource(ctx, args.rowId);
    if (!source.ok) return { ok: false as const, reason: source.reason };

    const sets = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", source.brand._id),
      )
      .take(MAX_TARGET_SETS + 2);
    const candidates = sets.filter(
      (s) => source.kind === "row" || s._id !== source.row._id,
    );
    const truncated = candidates.length > MAX_TARGET_SETS;
    const listed = candidates
      .slice(0, MAX_TARGET_SETS)
      .sort((a, b) => a.value.localeCompare(b.value));

    const targets = [];
    for (const target of listed) {
      const type = await insertTypeOf(ctx, target._id);
      targets.push({
        setId: target._id,
        value: target.value,
        ...(type ? { insertTypeId: type._id, insertTypeValue: type.value } : {}),
      });
    }

    let suggestedSetId: RowId | undefined;
    const own = source.ownSet
      ? targets.find((t) => t.setId === source.ownSet!._id && t.insertTypeId)
      : undefined;
    if (own) {
      suggestedSetId = own.setId;
    } else {
      let longest = -1;
      for (const t of targets) {
        if (!t.insertTypeId) continue;
        if (matchesBrandPrefix(source.row.value, t.value) && t.value.length > longest) {
          longest = t.value.length;
          suggestedSetId = t.setId;
        }
      }
      suggestedSetId ??= targets.find((t) => t.insertTypeId)?.setId;
    }

    return {
      ok: true as const,
      kind: source.kind,
      rowValue: source.row.value,
      brandValue: source.brand.value,
      ...(source.ownSet ? { ownSetId: source.ownSet._id, ownSetValue: source.ownSet.value } : {}),
      cardCount: await sourceCardCount(ctx, source),
      targets,
      ...(suggestedSetId ? { suggestedSetId } : {}),
      truncated,
    };
  },
});

const destinationValidator = v.object({
  _id: v.id("selectorOptions"),
  value: v.string(),
  /** This row (or, for an insert, a parallel under it) already holds a moving link. */
  holdsLink: v.boolean(),
  /** What landing on THIS row would leave behind. */
  loses: lossValidator,
});

/** What `getMakeInsertTargetDetail` answers; mirrors its validator. */
type TargetDetail =
  | Refused
  | {
      ok: true;
      targetSetValue: string;
      insertTypeId: RowId;
      insertTypeValue: string;
      inserts: Array<{ _id: RowId; value: string; holdsLink: boolean; loses: ConversionLoss }>;
      holdsLinkReason?: string;
      newLoses: ConversionLoss;
      newInsertName?: string;
      newInsertRefusal?: string;
      sameAsInsertId?: RowId;
      truncated: boolean;
    };

/**
 * The dialog's second read, for the set the operator picked: its Insert type,
 * the inserts under it, and what a new insert would be called — or, when a
 * new one is not allowed, the mutation's own sentence and the insert to add
 * to instead. `holdsLinkReason` present = NO landing under this set is
 * allowed (a holder, or too many rows to check), and says why.
 */
export const getMakeInsertTargetDetail = query({
  args: {
    rowId: v.id("selectorOptions"),
    targetSetId: v.id("selectorOptions"),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({
      ok: v.literal(true),
      targetSetValue: v.string(),
      insertTypeId: v.id("selectorOptions"),
      insertTypeValue: v.string(),
      /** The inserts, sorted by name; never the source row itself. */
      inserts: v.array(destinationValidator),
      holdsLinkReason: v.optional(v.string()),
      /** What a NEW insert (or new parallel) would leave behind. */
      newLoses: lossValidator,
      newInsertName: v.optional(v.string()),
      newInsertRefusal: v.optional(v.string()),
      /** The existing insert the refusal points at, to preselect. */
      sameAsInsertId: v.optional(v.id("selectorOptions")),
      /** More than `MAX_TARGET_INSERTS` inserts: the list is partial. */
      truncated: v.boolean(),
    }),
  ),
  handler: async (ctx, args): Promise<TargetDetail> => {
    await requireAdmin(ctx);
    const source = await readInsertConversionSource(ctx, args.rowId);
    if (!source.ok) return { ok: false as const, reason: source.reason };
    const target = await resolveTargetSet(ctx, source, args.targetSetId);
    if (!target.ok) return { ok: false as const, reason: target.reason };
    const { targetSet, insertType } = target;

    const tree = await readInsertTree(ctx, insertType._id);
    const moving = movingIds(source);
    const own = new Set<string>(source.rows.map((r) => r._id));
    const inserts = tree.inserts
      .filter((i) => !own.has(i._id))
      .sort((a, b) => a.value.localeCompare(b.value));
    const block = treeBlock(tree, source, targetSet);
    const check = newInsertCheck(source, targetSet, tree.inserts);
    return {
      ok: true as const,
      targetSetValue: targetSet.value,
      insertTypeId: insertType._id,
      insertTypeValue: insertType.value,
      inserts: inserts.slice(0, MAX_TARGET_INSERTS).map((i) => ({
        _id: i._id,
        value: i.value,
        holdsLink:
          holdsMoving(i, moving) ||
          (tree.parallelsOf.get(i._id) ?? []).some((p) => holdsMoving(p, moving)),
        loses: lossOnto(source.data, i),
      })),
      ...(block ? { holdsLinkReason: block } : {}),
      newLoses: lossOnto(source.data, null),
      ...(check.ok
        ? { newInsertName: check.name }
        : {
            newInsertRefusal: check.reason,
            ...(check.sameAsInsertId ? { sameAsInsertId: check.sameAsInsertId } : {}),
          }),
      truncated: tree.truncated || inserts.length > MAX_TARGET_INSERTS,
    };
  },
});

/** An insert the operator picked, checked to sit under an Insert type the source may move to. */
async function resolveInsert(
  ctx: { db: QueryCtx["db"] },
  source: InsertSource,
  insertId: RowId,
): Promise<Refused | ({ ok: true; insert: Row } & Target)> {
  const insert = await ctx.db.get(insertId);
  if (!insert || insert.level !== "insert" || !insert.parentId) {
    return { ok: false, reason: insertConversionRefusal.insertGone() };
  }
  if (source.rows.some((r) => r._id === insert._id)) {
    return { ok: false, reason: insertConversionRefusal.self(source.row.value) };
  }
  const target = await resolveTargetType(ctx, source, insert.parentId);
  if (!target.ok) return target;
  return { ok: true, insert, targetSet: target.targetSet, insertType: target.insertType };
}

/** What `getMakeInsertInsertDetail` answers; mirrors its validator. */
type InsertDetail =
  | Refused
  | {
      ok: true;
      insertValue: string;
      targetSetValue: string;
      joinLoses: ConversionLoss;
      parallels: Array<{ _id: RowId; value: string; holdsLink: boolean; loses: ConversionLoss }>;
      holdsLinkReason?: string;
      newLoses: ConversionLoss;
      newParallelName?: string;
      newParallelRefusal?: string;
      sameAsInsertSelf: boolean;
      sameAsParallelId?: RowId;
    };

/**
 * The dialog's third read, once an existing insert is picked: joining the
 * insert itself, its parallels, and what a new parallel of it would be
 * called. `sameAsInsertSelf` says the label IS the insert's name, so the
 * dialog preselects "The insert itself".
 */
export const getMakeInsertInsertDetail = query({
  args: {
    rowId: v.id("selectorOptions"),
    insertId: v.id("selectorOptions"),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({
      ok: v.literal(true),
      insertValue: v.string(),
      targetSetValue: v.string(),
      /** What joining the insert itself would leave behind. */
      joinLoses: lossValidator,
      parallels: v.array(destinationValidator),
      /** Present = no landing under this set is allowed; says why. */
      holdsLinkReason: v.optional(v.string()),
      newLoses: lossValidator,
      newParallelName: v.optional(v.string()),
      newParallelRefusal: v.optional(v.string()),
      sameAsInsertSelf: v.boolean(),
      sameAsParallelId: v.optional(v.id("selectorOptions")),
    }),
  ),
  handler: async (ctx, args): Promise<InsertDetail> => {
    await requireAdmin(ctx);
    const source = await readInsertConversionSource(ctx, args.rowId);
    if (!source.ok) return { ok: false as const, reason: source.reason };
    const resolved = await resolveInsert(ctx, source, args.insertId);
    if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
    const { insert, targetSet, insertType } = resolved;

    const tree = await readInsertTree(ctx, insertType._id);
    const block = treeBlock(tree, source, targetSet);
    const moving = movingIds(source);
    const parallels = (tree.parallelsOf.get(insert._id) ??
      (await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "parallel").eq("parentId", insert._id),
        )
        .take(MAX_INSERT_TREE_ROWS))
    ).sort((a, b) => a.value.localeCompare(b.value));
    const check = parallelNameCheck(source, targetSet, insert.value, parallels, "insertOwnName");
    return {
      ok: true as const,
      insertValue: insert.value,
      targetSetValue: targetSet.value,
      joinLoses: lossOnto(source.data, insert),
      parallels: parallels.map((p) => ({
        _id: p._id,
        value: p.value,
        holdsLink: holdsMoving(p, moving),
        loses: lossOnto(source.data, p),
      })),
      ...(block ? { holdsLinkReason: block } : {}),
      newLoses: lossOnto(source.data, null),
      ...(check.ok
        ? { newParallelName: check.name }
        : {
            newParallelRefusal: check.reason,
            ...(check.sameAsParallelId ? { sameAsParallelId: check.sameAsParallelId } : {}),
          }),
      sameAsInsertSelf: !check.ok && check.sameAsInsertSelf === true,
    };
  },
});

/**
 * "New insert named…" as the operator types: the insert and the parallel the
 * source would become — or the mutation's own sentence.
 */
export const getMakeInsertNamedPreview = query({
  args: {
    rowId: v.id("selectorOptions"),
    targetSetId: v.id("selectorOptions"),
    name: v.string(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(false),
      reason: v.string(),
      sameAsInsertId: v.optional(v.id("selectorOptions")),
    }),
    v.object({ ok: v.literal(true), insertName: v.string(), parallelName: v.string() }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await readInsertConversionSource(ctx, args.rowId);
    if (!source.ok) return { ok: false as const, reason: source.reason };
    const target = await resolveTargetSet(ctx, source, args.targetSetId);
    if (!target.ok) return { ok: false as const, reason: target.reason };
    const tree = await readInsertTree(ctx, target.insertType._id);
    const block = treeBlock(tree, source, target.targetSet);
    if (block) return { ok: false as const, reason: block };
    const check = namedCheck(source, target.targetSet, tree.inserts, args.name);
    if (!check.ok) {
      return {
        ok: false as const,
        reason: check.reason,
        ...(check.sameAsInsertId ? { sameAsInsertId: check.sameAsInsertId } : {}),
      };
    }
    return { ok: true as const, insertName: check.insertName, parallelName: check.parallelName };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// The move
// ───────────────────────────────────────────────────────────────────────────

/**
 * A new row under `parent`, born the way the set builder's other creation
 * paths make one: flags from `derivedVariantFlags`, features = the parent's
 * copy-down, then the source's operator data, then the row's own level
 * derivation; teams from the source, else inherited; the moving links in
 * fresh slots.
 */
async function insertChildRow(
  ctx: MutationCtx,
  args: {
    level: "insert" | "parallel";
    value: string;
    parent: Row;
    links: ReadonlyArray<MovingLink>;
    data: SourceData | null;
    adminUserId: string;
    now: number;
  },
): Promise<{ row: Row; slotById: Record<string, string> }> {
  const { level, value, parent, links, data, adminUserId, now } = args;
  const flags = derivedVariantFlags(level, parent);
  const features = {
    ...(parent.features ?? {}),
    ...(data?.features ?? {}),
    ...deriveOwnLevelFeatures(level, value, flags),
  };
  const teamIds = data?.teamIds ? [...data.teamIds] : inheritedTeamIds(parent);
  const metadata = {
    ...(flags ?? {}),
    ...(data?.cardNumberPrefix !== undefined ? { cardNumberPrefix: data.cardNumberPrefix } : {}),
  };
  const alloc = initialSlots({
    sportlots: links.map((l) => ({ id: l.id, label: l.label })),
  });
  const id = await ctx.db.insert("selectorOptions", {
    level,
    value,
    platformData: alloc.platformData,
    platformLabels: alloc.platformLabels,
    platformSlotSeq: alloc.platformSlotSeq,
    parentId: parent._id,
    children: [],
    createdByUserId: adminUserId,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(Object.keys(features).length > 0 ? { features } : {}),
    ...(teamIds ? { teamIds } : {}),
    lastUpdated: now,
  });
  const freshParent = (await ctx.db.get(parent._id))!;
  await ctx.db.patch(parent._id, { children: unionChildren(freshParent.children, [id]) });
  return { row: (await ctx.db.get(id))!, slotById: alloc.slotByIdBySide.sportlots };
}

/** The moving links onto an existing row, BSC side untouched. */
async function joinRow(
  ctx: MutationCtx,
  dest: Row,
  links: ReadonlyArray<MovingLink>,
  now: number,
): Promise<Record<string, string>> {
  const alloc = allocateSlots(dest, {
    sportlots: links.map((l) => ({ id: l.id, label: l.label })),
  });
  await ctx.db.patch(dest._id, {
    platformData: alloc.platformData,
    platformLabels: alloc.platformLabels,
    platformSlotSeq: alloc.platformSlotSeq,
    lastUpdated: now,
  });
  return alloc.slotByIdBySide.sportlots;
}

const landingValidator = v.union(
  v.object({ kind: v.literal("newInsert") }),
  v.object({ kind: v.literal("joinInsert"), insertId: v.id("selectorOptions") }),
  v.object({ kind: v.literal("newParallel"), insertId: v.id("selectorOptions") }),
  v.object({ kind: v.literal("joinParallel"), parallelId: v.id("selectorOptions") }),
  v.object({ kind: v.literal("newInsertNamed"), name: v.string() }),
);

const pathStepValidator = v.object({
  _id: v.id("selectorOptions"),
  level: v.union(
    v.literal("setName"),
    v.literal("variantType"),
    v.literal("insert"),
    v.literal("parallel"),
  ),
  value: v.string(),
});

type PathStep = {
  _id: RowId;
  level: "setName" | "variantType" | "insert" | "parallel";
  value: string;
};

/**
 * NEO-306 — "Make insert of…".
 *
 * The source (S1 or S2) moves under `targetInsertTypeId`, a variant type
 * whose NB role is "insert", onto the `landing`. Every SportLots link on the
 * source moves — id and label — into slots allocated on the destination; the
 * cards follow their own slot; guest cross-listings follow the row; the
 * emptied source rows are deleted child-first through the trash icon's own
 * helper, in this same transaction, so a row that is not in fact empty
 * refuses and nothing lands.
 *
 * Returns the drill path to the landed row (set → Insert type → insert →
 * parallel) with each row's NB name, for the toast and the cascade.
 */
export const convertToInsert = mutation({
  args: {
    rowId: v.id("selectorOptions"),
    targetInsertTypeId: v.id("selectorOptions"),
    landing: landingValidator,
  },
  returns: v.object({
    path: v.array(pathStepValidator),
    landedValue: v.string(),
    created: v.boolean(),
    targetSetValue: v.string(),
  }),
  handler: async (ctx, args) => {
    const adminUserId = await requireAdmin(ctx);
    const source = await readInsertConversionSource(ctx, args.rowId);
    if (!source.ok) throw new ConvexError(source.reason);
    const target = await resolveTargetType(ctx, source, args.targetInsertTypeId);
    if (!target.ok) throw new ConvexError(target.reason);
    const { targetSet, insertType } = target;
    const rowValue = source.row.value;

    for (const row of source.rows) {
      if (await hasOpenReview(ctx, row._id)) {
        throw new ConvexError(insertConversionRefusal.reviewOpen(rowValue));
      }
    }

    // Cards and guests, bounded before anything is written.
    const cardsByRow = new Map<RowId, Doc<"cardChecklist">[]>();
    let cardTotal = 0;
    for (const row of source.rows) {
      const cards = await cardsOn(ctx, row._id, MAX_CARDS_PER_MOVE + 1);
      cardsByRow.set(row._id, cards);
      cardTotal += cards.length;
    }
    if (cardTotal > MAX_CARDS_PER_MOVE) {
      throw new ConvexError(insertConversionRefusal.tooManyCards(rowValue, MAX_CARDS_PER_MOVE));
    }
    const guestLinks: Doc<"cardCrossListings">[] = [];
    for (const row of source.rows) {
      guestLinks.push(
        ...(await ctx.db
          .query("cardCrossListings")
          .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", row._id))
          .take(MAX_CROSS_LISTINGS_PER_MOVE + 1)),
      );
    }
    if (guestLinks.length > MAX_CROSS_LISTINGS_PER_MOVE) {
      throw new ConvexError(
        insertConversionRefusal.tooManyGuests(rowValue, MAX_CROSS_LISTINGS_PER_MOVE),
      );
    }

    // The link-taken rule, over the whole Insert type: inserts AND their parallels.
    const tree = await readInsertTree(ctx, insertType._id);
    const block = treeBlock(tree, source, targetSet);
    if (block) throw new ConvexError(block);

    const links = linksOnRows(source.rows);
    const now = Date.now();
    const landing = args.landing;
    const path: PathStep[] = [
      { _id: targetSet._id, level: "setName", value: targetSet.value },
      { _id: insertType._id, level: "variantType", value: insertType.value },
    ];
    const step = (row: Row): PathStep => ({
      _id: row._id,
      level: row.level as PathStep["level"],
      value: row.value,
    });

    let dest: Row;
    let created: boolean;
    let slotById: Record<string, string>;
    let loss: ConversionLoss;

    const pickInsert = (insertId: RowId): Row => {
      if (source.rows.some((r) => r._id === insertId)) {
        throw new ConvexError(insertConversionRefusal.self(rowValue));
      }
      const insert = tree.inserts.find((i) => i._id === insertId);
      if (!insert) throw new ConvexError(insertConversionRefusal.insertGone());
      return insert;
    };

    switch (landing.kind) {
      case "newInsert": {
        const check = newInsertCheck(source, targetSet, tree.inserts);
        if (!check.ok) throw new ConvexError(check.reason);
        const made = await insertChildRow(ctx, {
          level: "insert",
          value: check.name,
          parent: insertType,
          links,
          data: source.data,
          adminUserId,
          now,
        });
        dest = made.row;
        slotById = made.slotById;
        created = true;
        loss = lossOnto(source.data, null);
        path.push(step(dest));
        break;
      }
      case "joinInsert": {
        const insert = pickInsert(landing.insertId);
        // Cards landing on a row mid-review would land under a commit that
        // does not know about them (security audit, NEO-305).
        if (await hasOpenReview(ctx, insert._id)) {
          throw new ConvexError(insertConversionRefusal.reviewOpen(insert.value));
        }
        loss = lossOnto(source.data, insert);
        slotById = await joinRow(ctx, insert, links, now);
        dest = insert;
        created = false;
        path.push(step(insert));
        break;
      }
      case "newParallel": {
        const insert = pickInsert(landing.insertId);
        const siblings = tree.parallelsOf.get(insert._id) ?? [];
        const check = parallelNameCheck(source, targetSet, insert.value, siblings, "insertOwnName");
        if (!check.ok) throw new ConvexError(check.reason);
        const made = await insertChildRow(ctx, {
          level: "parallel",
          value: check.name,
          parent: insert,
          links,
          data: source.data,
          adminUserId,
          now,
        });
        dest = made.row;
        slotById = made.slotById;
        created = true;
        loss = lossOnto(source.data, null);
        path.push(step(insert), step(dest));
        break;
      }
      case "joinParallel": {
        const parallel = await ctx.db.get(landing.parallelId);
        if (!parallel || parallel.level !== "parallel" || !parallel.parentId) {
          throw new ConvexError(insertConversionRefusal.parallelGone());
        }
        const insert = tree.inserts.find((i) => i._id === parallel.parentId);
        if (!insert) throw new ConvexError(insertConversionRefusal.parallelGone());
        if (await hasOpenReview(ctx, parallel._id)) {
          throw new ConvexError(insertConversionRefusal.reviewOpen(parallel.value));
        }
        loss = lossOnto(source.data, parallel);
        slotById = await joinRow(ctx, parallel, links, now);
        dest = parallel;
        created = false;
        path.push(step(insert), step(parallel));
        break;
      }
      case "newInsertNamed": {
        const check = namedCheck(source, targetSet, tree.inserts, landing.name);
        if (!check.ok) throw new ConvexError(check.reason);
        // The typed insert holds no link and none of the source's data: the
        // cards, and the operator's attributes for them, are the parallel's.
        const insert = await insertChildRow(ctx, {
          level: "insert",
          value: check.insertName,
          parent: insertType,
          links: [],
          data: null,
          adminUserId,
          now,
        });
        const made = await insertChildRow(ctx, {
          level: "parallel",
          value: check.parallelName,
          parent: insert.row,
          links,
          data: source.data,
          adminUserId,
          now,
        });
        dest = made.row;
        slotById = made.slotById;
        created = true;
        loss = lossOnto(source.data, null);
        path.push(step(insert.row), step(dest));
        break;
      }
    }

    // ── cards follow their own links ──────────────────────────────────
    const moves = [];
    for (const row of source.rows) {
      const map = new Map<string, string>();
      for (const l of links) {
        if (l.from !== row._id) continue;
        const destSlot = slotById[l.id];
        if (destSlot) map.set(l.slot, destSlot);
      }
      // BSC: the source carries no BSC slot (guarded), so every BSC `src` on
      // these cards is already dangling and is cleared, ref kept.
      for (const card of cardsByRow.get(row._id) ?? []) {
        moves.push({ card, slotMap: { sportlots: map } });
      }
    }
    await moveCards(ctx, dest._id, moves, now);
    await moveGuestCrossListings(ctx, guestLinks, dest._id, now);

    // ── end the emptied rows, child first, through the trash icon's helper ──
    for (const row of source.rows) {
      await deleteEmptySelectorOptionRow(ctx, (await ctx.db.get(row._id))!, adminUserId);
    }

    console.log(
      JSON.stringify({
        msg: "row_converted_to_insert",
        adminUserId,
        rowId: source.row._id,
        sourceKind: source.kind,
        deleted: source.rows.map((r) => r._id),
        targetSetId: targetSet._id,
        insertTypeId: insertType._id,
        landing: landing.kind,
        destId: dest._id,
        created,
        links: links.length,
        cards: cardTotal,
        guests: guestLinks.length,
        // Operator-typed fields the deleted rows carried that the destination
        // does not keep — named to the operator in the dialog before confirm.
        dropped: lossFieldNames(loss),
      }),
    );

    return {
      path,
      landedValue: dest.value,
      created,
      targetSetValue: targetSet.value,
    };
  },
});
