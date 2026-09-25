/**
 * NEO-305 — two operator doors that move a SportLots link between a SET and
 * a PARALLEL, keyed by id end to end.
 *
 * ## Why they exist
 *
 * Sync Sets used to file SportLots' flat list under a brand as sets, so
 * "Bowman Blue", "Bowman Gold" and friends became top-level sets beside
 * Bowman when they are Bowman's parallels (Part A of NEO-305 stops that at
 * the sync boundary). The rows already created are fixed here, by hand, and
 * the way back exists for the day the sync files a real SportLots-only set
 * as a flagship parallel:
 *
 *  - `convertSetToParallel` — "Make parallel of…": a set that is nothing but
 *    a Base carrying SportLots links becomes (or joins) a parallel row under
 *    another set's Parallel variant type. Its links, labels and cards move;
 *    the emptied Base and set are deleted in the same transaction.
 *  - `promoteParallelToSet` — "Promote to set": one SportLots link on a
 *    parallel row becomes a set with a Base again (the same shape
 *    `insertSetWithBaseFromSl` mints for the sync), or joins an existing
 *    set's Base. The cards attributed to that link move with it; the
 *    parallel row goes only when nothing is left on it.
 *
 * ## The invariants this file is built around
 *
 *  - KEYED BY ID. A link moves as (marketplace id, label) and lands in a
 *    slot allocated on the destination (`allocateSlots` / `initialSlots`).
 *    A card follows its OWN slot: its `platformData.<side>.src` is remapped
 *    from the source row's slot key to the destination's. Nothing reads a
 *    marketplace name to decide anything; the only names derived here are
 *    the new row's NB name, once, at creation (product invariant 2a).
 *  - A LINK IS NEVER DROPPED. Every SportLots id on the source ends up on the
 *    destination, with its label. A card's ref is never removed; a `src`
 *    that pointed at nothing on the source (already dangling) is cleared
 *    rather than carried, because slot keys are per row — carried over, it
 *    would silently point at whatever the destination holds under that key.
 *  - CARD NUMBERS ARE NEVER ASSUMED UNIQUE. Cards are moved by `_id` and
 *    attributed by slot. Two cards with one number both move, or both stay.
 *  - NEVER GUESS. A card the promote cannot attribute by id to exactly one
 *    side of the split (it carries the promoted SportLots link AND a live BSC
 *    link that stays behind) refuses the whole promote, rather than choosing.
 *
 * The helpers that carry these rules (the bounds, the card and cross-listing
 * moves, the link list, the loss report, the S1 source guards) live in
 * `setShapeMove.ts`, shared with "Make insert of…" (NEO-306).
 *
 * ## Sync stickiness
 *
 * `listBrandSubtreeSlIds` walks setName → variantType → insert → parallel, so
 * an id is "covered" wherever under the brand it sits. After a convert the
 * id is on a parallel row and Sync Sets does not re-create the set; after a
 * promote it is on a set's Base and the flagship-parallel routing does not
 * re-absorb it. Both directions stick because both are keyed by id.
 *
 * ## Copy
 *
 * Every refusal is a `ConvexError` carrying one operator sentence (a plain
 * `Error` is redacted to "Server Error" on prod). NB names only, never an id
 * and never an internal word. DRAFT copy pending Jason's sign-off (NEO-245:
 * no copywriter agent).
 */

import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";
import { inheritedTeamIds } from "./lib/selectorTeams";
import {
  allocateSlots,
  detachSlot,
  idForSlot,
  initialSlots,
  isSlotKeyForSide,
  slotEntries,
  slotForId,
  slotIds,
  slotLabel,
} from "./platformSlots";
import {
  collectSelectorOptionHoldings,
  deleteEmptySelectorOptionRow,
} from "./selectorOptions";
import {
  checkCustomSelectorValue,
  matchesBrandPrefix,
  selectorValueKey,
} from "./selectorSyncMatch";
import { unionChildren } from "./selectorSyncStore";
import {
  MAX_YEAR_SET_ROWS,
  candidateDefaultName,
  insertSetWithBaseFromSl,
} from "./setFromMarketplace";
import {
  MAX_CARDS_PER_MOVE,
  MAX_CARDS_PER_ROW_READ,
  MAX_CROSS_LISTINGS_PER_MOVE,
  MAX_TARGET_SETS,
  baseOf,
  brandSetsByKey,
  cardsOn,
  childrenOf,
  hasOpenReview,
  holdsAnyLink,
  insertRowsUnder,
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
  splitCardsForSlot,
  targetNamePrefixes,
  type ConversionLoss,
  type ConversionSource,
  variantTypeWithRole,
} from "./setShapeMove";
import { derivedVariantFlags, variantTypeRole } from "./variantRole";

type Row = Doc<"selectorOptions">;
type RowId = Id<"selectorOptions">;

// The bounds and the shared move helpers live in `setShapeMove.ts` (NEO-306),
// so every shape-changing door keeps one set of invariants. Re-exported here
// for the callers and tests that import them from this module.
export {
  MAX_CARDS_PER_MOVE,
  MAX_CARDS_PER_ROW_READ,
  MAX_CROSS_LISTINGS_PER_MOVE,
  MAX_TARGET_SETS,
  type ConversionLoss,
};
export { remapCardPlatformData } from "./setShapeMove";

// ───────────────────────────────────────────────────────────────────────────
// Operator sentences (DRAFT — pending Jason's sign-off)
// ───────────────────────────────────────────────────────────────────────────

export const conversionRefusal = {
  setGone: () => "That set is gone. Refresh and try again.",
  notASet: () => "Only a set can become a parallel.",
  onBsc: (set: string) => `BSC lists “${set}” as a set, so it stays a set.`,
  noBase: (set: string) => `“${set}” has no Base to move.`,
  moreThanBase: (set: string) =>
    `“${set}” has more than a Base under it. Clear out its other variant types first.`,
  baseHasRows: (set: string) =>
    `“${set}”’s Base has inserts or parallels under it. Move them out first.`,
  reviewOpen: (set: string) =>
    `A checklist review is open on “${set}”. Finish it, then try again.`,
  targetGone: () => "That Parallel type is gone. Refresh and try again.",
  self: (set: string) => `“${set}” can't be a parallel of itself.`,
  otherBrand: (target: string, brand: string) =>
    `“${target}” is under a different brand. Pick one of ${brand}’s sets.`,
  notParallelType: (type: string, target: string) =>
    `“${type}” under “${target}” isn't a Parallel type. Pick ${target}’s Parallel.`,
  attachGone: () => "That parallel moved. Refresh and try again.",
  ownName: (label: string, target: string) =>
    `“${label}” is ${target}’s own name, so it can't be a new parallel of it. Add it to an existing parallel instead.`,
  nameTaken: (target: string, name: string) =>
    `${target} already has a “${name}” parallel. Add it to that one instead.`,
  /**
   * The destination already holds one of the links. Refused in BOTH modes
   * (coordinator, NEO-305): the destination's own cards for that link are
   * already there, so moving this set's copies in would be a second copy of
   * each card. The remedy names the chip control that removes a link.
   */
  linkTaken: (target: string, name: string, set: string) =>
    `“${name}” under ${target} already has this SportLots link. Remove it from “${name}” first if “${set}” is the one to keep.`,
  badName: (reason: string) => `That name won't work: ${reason}.`,
  tooManyCards: (set: string, max: number) =>
    `“${set}” holds more than ${max.toLocaleString("en-US")} cards — more than one move can carry. Nothing changed.`,
  tooManyGuests: (set: string, max: number) =>
    `“${set}” has more than ${max} cards from other sets listed in it — more than one move can carry. Nothing changed.`,
};

export const promotionRefusal = {
  rowGone: () => "That row is gone. Refresh and try again.",
  /** Kept under its NEO-305 key; NEO-306 promotes inserts and parallels of inserts too. */
  notAParallel: (row: string) => `“${row}” isn't under a set, so it can't become one.`,
  linkGone: (row: string) =>
    `That SportLots link isn't on “${row}” any more. Refresh and try again.`,
  noBrand: () => "This row has no brand above it. Refresh and try again.",
  nameTaken: (brand: string, set: string) =>
    `${brand} already has a set called “${set}”. Add it to that set's Base instead.`,
  existsElsewhere: (set: string, otherBrand: string, brand: string) =>
    `There's already a “${set}” under ${otherBrand}. Move it to ${brand} with Move to another brand, then try again.`,
  badName: (reason: string) => `That name won't work: ${reason}.`,
  tooManySets: (brand: string) =>
    `${brand} has more than ${MAX_YEAR_SET_ROWS.toLocaleString("en-US")} sets — too many to check this name against. Nothing changed.`,
  attachGone: () => "That set moved. Refresh and try again.",
  attachOtherBrand: (set: string, brand: string) =>
    `“${set}” is under a different brand. Pick one of ${brand}’s sets.`,
  attachNoBase: (set: string) =>
    `“${set}” has no Base yet. Sync its variant types, then try again.`,
  /** The chosen set's Base already holds the link: its cards are there already. */
  linkTaken: (set: string, row: string) =>
    `“${set}”’s Base already has this SportLots link. Remove it from “${row}” instead if that copy isn't needed.`,
  paired: (row: string, count: number) =>
    `${count} ${count === 1 ? "card" : "cards"} on “${row}” ${
      count === 1 ? "is" : "are"
    } matched to BSC as well as SportLots, so ${
      count === 1 ? "it" : "they"
    } can't be split off. Nothing changed.`,
  tooManyCards: (row: string, max: number) =>
    `“${row}” holds more than ${max.toLocaleString("en-US")} cards for that link — more than one move can carry. Nothing changed.`,
  reviewOpen: (row: string) =>
    `A checklist review is open on “${row}”. Finish it, then try again.`,
};

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * The NB name a new parallel is born with: the SportLots label with the
 * target set's name taken off the front (whole word, case-insensitive — the
 * `matchesBrandPrefix` rule), so "Bowman Blue" under Bowman is "Blue" and
 * "Bowman Chrome Blue Refractor" under Bowman Chrome is "Blue Refractor".
 *
 * SportLots files some lists brand-stripped ("Chrome Blue Refractor"), so the
 * target's name without its brand's set-name prefix is tried second. A label
 * that matches neither keeps its whole self.
 *
 * `null` when the label IS the target's name: that entry is the target's own
 * checklist, not a parallel of it, and a parallel called "Bowman" under
 * Bowman is a row nobody wants. Derived once, at creation, and never re-read.
 *
 * A thin wrapper over `nameAfterPrefixes` (NEO-306), kept so its callers and
 * tests stand unchanged.
 */
export function parallelNameFromLabel(
  label: string,
  targetSetValue: string,
  brandSetNamePrefix?: string,
): string | null {
  return nameAfterPrefixes(label, targetNamePrefixes(targetSetValue, brandSetNamePrefix));
}

// ───────────────────────────────────────────────────────────────────────────
// Shared reads
// ───────────────────────────────────────────────────────────────────────────

/**
 * The first variant type under `setId` whose NB role is "parallel". Bounded
 * at `MAX_VARIANT_TYPES_PER_SET` and fail closed past it ("no Parallel type
 * yet"); see `variantTypeWithRole`.
 */
function parallelTypeOf(
  ctx: { db: QueryCtx["db"] },
  setId: RowId,
): Promise<Row | null> {
  return variantTypeWithRole(ctx, setId, "parallel");
}

// ───────────────────────────────────────────────────────────────────────────
// Part B — "Make parallel of…"
// ───────────────────────────────────────────────────────────────────────────

/** S1 source guards, refused in this door's own sentences. */
function readSetSource(
  ctx: { db: QueryCtx["db"] },
  setId: RowId,
): Promise<ConversionSource> {
  return readConversionSource(ctx, setId, conversionRefusal);
}

/** The rows a convert empties, child first: the Base, then the set. */
function sourceRows(source: { set: Row; base: Row }): Row[] {
  return [source.base, source.set];
}

type TargetResolution =
  | { ok: false; reason: string }
  | { ok: true; targetType: Row; targetSet: Row };

async function resolveTarget(
  ctx: { db: QueryCtx["db"] },
  source: { set: Row; brand: Row },
  targetParallelTypeId: RowId,
): Promise<TargetResolution> {
  const targetType = await ctx.db.get(targetParallelTypeId);
  if (!targetType || targetType.level !== "variantType" || !targetType.parentId) {
    return { ok: false, reason: conversionRefusal.targetGone() };
  }
  if (targetType.parentId === source.set._id) {
    return { ok: false, reason: conversionRefusal.self(source.set.value) };
  }
  const targetSet = await ctx.db.get(targetType.parentId);
  if (!targetSet || targetSet.level !== "setName") {
    return { ok: false, reason: conversionRefusal.targetGone() };
  }
  if (targetSet._id === source.set._id) {
    return { ok: false, reason: conversionRefusal.self(source.set.value) };
  }
  // Same brand is same year: a brand row belongs to exactly one year.
  if (targetSet.parentId !== source.brand._id) {
    return {
      ok: false,
      reason: conversionRefusal.otherBrand(targetSet.value, source.brand.value),
    };
  }
  if (variantTypeRole(targetType) !== "parallel") {
    return {
      ok: false,
      reason: conversionRefusal.notParallelType(targetType.value, targetSet.value),
    };
  }
  return { ok: true, targetType, targetSet };
}

/**
 * Would a NEW parallel be allowed under `targetType`, and what is it called?
 * The same checks the mutation makes, shared so the dialog can disable the
 * choice with the mutation's own sentence.
 */
function newParallelCheck(
  source: { set: Row; base: Row; brand: Row },
  targetSet: Row,
  siblings: ReadonlyArray<Row>,
):
  | { ok: true; name: string }
  | { ok: false; reason: string; name: string | null; sameAs?: RowId } {
  const label = namingLabel(sourceRows(source), source.set.value);
  const derived = parallelNameFromLabel(
    label,
    targetSet.value,
    source.brand.metadata?.setNamePrefix,
  );
  if (derived === null) {
    return {
      ok: false,
      reason: conversionRefusal.ownName(label, targetSet.value),
      name: null,
    };
  }
  const checked = checkCustomSelectorValue("insert", derived);
  if (!checked.ok) {
    return { ok: false, reason: conversionRefusal.badName(checked.reason), name: derived };
  }
  const key = selectorValueKey(checked.value);
  const clash = siblings.find((s) => selectorValueKey(s.value) === key);
  if (clash) {
    return {
      ok: false,
      reason: conversionRefusal.nameTaken(targetSet.value, clash.value),
      name: checked.value,
      sameAs: clash._id,
    };
  }
  const holder = siblings.find((s) => holdsAnyLink(s, sourceRows(source)));
  if (holder) {
    // No `sameAs`: adding to the holder is refused for the same reason.
    return {
      ok: false,
      reason: conversionRefusal.linkTaken(targetSet.value, holder.value, source.set.value),
      name: checked.value,
    };
  }
  return { ok: true, name: checked.value };
}

/**
 * Whether the "Make parallel of…" row action is offered on a set. Only the
 * source-side guards: which target the operator picks is the dialog's
 * question, and the mutation re-checks everything.
 */
export const getSetToParallelEligibility = query({
  args: { setId: v.id("selectorOptions") },
  returns: v.object({ eligible: v.boolean() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await readSetSource(ctx, args.setId);
    return { eligible: source.ok };
  },
});

const targetSetValidator = v.object({
  setId: v.id("selectorOptions"),
  value: v.string(),
  /** Absent when the set has no Parallel type yet. */
  parallelTypeId: v.optional(v.id("selectorOptions")),
  parallelTypeValue: v.optional(v.string()),
});

/**
 * The dialog's first read: the brand's other sets, each with its Parallel
 * type when it has one, and which one to preselect. Asked only while the
 * dialog is open.
 *
 * The preselection is a DISPLAY default over NB names (the set whose name is
 * the longest whole-word prefix of this one's, among sets that can take a
 * parallel) — never a decision the server acts on.
 */
export const getSetToParallelTargets = query({
  args: { setId: v.id("selectorOptions") },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({
      ok: v.literal(true),
      setValue: v.string(),
      brandValue: v.string(),
      cardCount: v.number(),
      targets: v.array(targetSetValidator),
      suggestedSetId: v.optional(v.id("selectorOptions")),
      truncated: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await readSetSource(ctx, args.setId);
    if (!source.ok) return { ok: false as const, reason: source.reason };
    const { set, base, brand } = source;

    const siblings = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", brand._id),
      )
      .take(MAX_TARGET_SETS + 2);
    const others = siblings.filter((s) => s._id !== set._id);
    const truncated = others.length > MAX_TARGET_SETS;
    const listed = others
      .slice(0, MAX_TARGET_SETS)
      .sort((a, b) => a.value.localeCompare(b.value));

    const targets = [];
    for (const target of listed) {
      const type = await parallelTypeOf(ctx, target._id);
      targets.push({
        setId: target._id,
        value: target.value,
        ...(type ? { parallelTypeId: type._id, parallelTypeValue: type.value } : {}),
      });
    }

    let suggestedSetId: RowId | undefined;
    let longest = -1;
    for (const t of targets) {
      if (!t.parallelTypeId) continue;
      if (matchesBrandPrefix(set.value, t.value) && t.value.length > longest) {
        longest = t.value.length;
        suggestedSetId = t.setId;
      }
    }
    suggestedSetId ??= targets.find((t) => t.parallelTypeId)?.setId;

    const cards =
      (await cardsOn(ctx, base._id, MAX_CARDS_PER_MOVE + 1)).length +
      (await cardsOn(ctx, set._id, MAX_CARDS_PER_MOVE + 1)).length;

    return {
      ok: true as const,
      setValue: set.value,
      brandValue: brand.value,
      cardCount: cards,
      targets,
      ...(suggestedSetId ? { suggestedSetId } : {}),
      truncated,
    };
  },
});

/** What `getSetToParallelTargetDetail` answers; mirrors its validator. */
type TargetDetail =
  | { ok: false; reason: string }
  | {
      ok: true;
      targetSetValue: string;
      parallelTypeId: RowId;
      parallelTypeValue: string;
      parallels: Array<{
        _id: RowId;
        value: string;
        holdsLink: boolean;
        loses: ConversionLoss;
      }>;
      holdsLinkReason?: string;
      newLoses: ConversionLoss;
      newName?: string;
      newRefusal?: string;
      sameAsId?: RowId;
    };

/**
 * The dialog's second read, for the target set the operator has picked: its
 * Parallel type, the parallels already under it, and what a new one would be
 * called — or, when a new one is not allowed, the mutation's own sentence and
 * the parallel to add to instead.
 */
export const getSetToParallelTargetDetail = query({
  args: {
    setId: v.id("selectorOptions"),
    targetSetId: v.id("selectorOptions"),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({
      ok: v.literal(true),
      targetSetValue: v.string(),
      parallelTypeId: v.id("selectorOptions"),
      parallelTypeValue: v.string(),
      parallels: v.array(
        v.object({
          _id: v.id("selectorOptions"),
          value: v.string(),
          /**
           * Already holds one of the links this set would bring. Not a
           * destination in either mode; `holdsLinkReason` says why.
           */
          holdsLink: v.boolean(),
          /** What adding to THIS parallel would leave behind. */
          loses: lossValidator,
        }),
      ),
      /**
       * Some parallel here already holds one of the links. Then NO parallel
       * here is a destination, new or existing (security audit, NEO-305):
       * the link would end up on two rows of one Parallel type.
       */
      holdsLinkReason: v.optional(v.string()),
      /** What a NEW parallel would leave behind (it carries the rest). */
      newLoses: lossValidator,
      /** The new parallel's name, when one can be made. */
      newName: v.optional(v.string()),
      /** Why a new parallel cannot be made, when it cannot. */
      newRefusal: v.optional(v.string()),
      /** The existing parallel the refusal points at, to preselect. */
      sameAsId: v.optional(v.id("selectorOptions")),
    }),
  ),
  handler: async (ctx, args): Promise<TargetDetail> => {
    await requireAdmin(ctx);
    const source = await readSetSource(ctx, args.setId);
    if (!source.ok) return { ok: false as const, reason: source.reason };
    const targetSet = await ctx.db.get(args.targetSetId);
    if (!targetSet || targetSet.level !== "setName") {
      return { ok: false as const, reason: conversionRefusal.targetGone() };
    }
    if (targetSet._id === source.set._id) {
      return { ok: false as const, reason: conversionRefusal.self(source.set.value) };
    }
    if (targetSet.parentId !== source.brand._id) {
      return {
        ok: false as const,
        reason: conversionRefusal.otherBrand(targetSet.value, source.brand.value),
      };
    }
    const type = await parallelTypeOf(ctx, targetSet._id);
    if (!type) {
      return {
        ok: false as const,
        reason: noParallelTypeYet(targetSet.value),
      };
    }
    const parallels = (await insertRowsUnder(ctx, type._id)).sort((a, b) =>
      a.value.localeCompare(b.value),
    );
    const check = newParallelCheck(source, targetSet, parallels);
    const holder = parallels.find((p) => holdsAnyLink(p, sourceRows(source)));
    const data = sourceDataOf(source.set, source.base);
    return {
      ok: true as const,
      targetSetValue: targetSet.value,
      parallelTypeId: type._id,
      parallelTypeValue: type.value,
      parallels: parallels.map((p) => ({
        _id: p._id,
        value: p.value,
        holdsLink: holdsAnyLink(p, sourceRows(source)),
        loses: lossOnto(data, p),
      })),
      newLoses: lossOnto(data, null),
      ...(holder
        ? {
            holdsLinkReason: conversionRefusal.linkTaken(
              targetSet.value,
              holder.value,
              source.set.value,
            ),
          }
        : {}),
      ...(check.ok
        ? { newName: check.name }
        : {
            newRefusal: check.reason,
            ...(check.sameAs ? { sameAsId: check.sameAs } : {}),
          }),
    };
  },
});

/** DRAFT copy: a target set with no Parallel variant type yet. */
export const noParallelTypeYet = (target: string): string =>
  `${target} has no Parallel type yet. Pick ${target}, run Sync Variant Types, then come back.`;

/**
 * NEO-305 Part B — "Make parallel of…".
 *
 * A set that is nothing but a Base holding SportLots links (the shape
 * `insertSetWithBaseFromSl` mints) becomes a parallel of another set in the
 * same brand: every SportLots link on the Base (and on the set row, if it
 * carries any) moves — id and label — onto `attachToId`, an existing
 * insert-level row under the target's Parallel type, or onto a new one
 * named by `parallelNameFromLabel` with flags from `derivedVariantFlags`.
 * The cards follow their own links; guest cross-listings follow the row.
 * The emptied Base and set are then deleted through the trash icon's own
 * helper, in this same transaction, so a row that is not in fact empty
 * refuses and nothing lands.
 */
export const convertSetToParallel = mutation({
  args: {
    setId: v.id("selectorOptions"),
    targetParallelTypeId: v.id("selectorOptions"),
    attachToId: v.optional(v.id("selectorOptions")),
  },
  returns: v.object({
    targetSetId: v.id("selectorOptions"),
    parallelTypeId: v.id("selectorOptions"),
    parallelId: v.id("selectorOptions"),
    parallelValue: v.string(),
    targetSetValue: v.string(),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const adminUserId = await requireAdmin(ctx);
    const source = await readSetSource(ctx, args.setId);
    if (!source.ok) throw new ConvexError(source.reason);
    const { set, base, brand } = source;

    const resolved = await resolveTarget(ctx, source, args.targetParallelTypeId);
    if (!resolved.ok) throw new ConvexError(resolved.reason);
    const { targetType, targetSet } = resolved;

    if ((await hasOpenReview(ctx, base._id)) || (await hasOpenReview(ctx, set._id))) {
      throw new ConvexError(conversionRefusal.reviewOpen(set.value));
    }

    // Cards, bounded before anything is written.
    const baseCards = await cardsOn(ctx, base._id, MAX_CARDS_PER_MOVE + 1);
    const setCards = await cardsOn(ctx, set._id, MAX_CARDS_PER_MOVE + 1);
    if (baseCards.length + setCards.length > MAX_CARDS_PER_MOVE) {
      throw new ConvexError(conversionRefusal.tooManyCards(set.value, MAX_CARDS_PER_MOVE));
    }
    const guestLinks = [];
    for (const rowId of [base._id, set._id]) {
      guestLinks.push(
        ...(await ctx.db
          .query("cardCrossListings")
          .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", rowId))
          .take(MAX_CROSS_LISTINGS_PER_MOVE + 1)),
      );
    }
    if (guestLinks.length > MAX_CROSS_LISTINGS_PER_MOVE) {
      throw new ConvexError(
        conversionRefusal.tooManyGuests(set.value, MAX_CROSS_LISTINGS_PER_MOVE),
      );
    }

    const links = linksOnRows([base, set]);
    const now = Date.now();
    const sourceData = sourceDataOf(set, base);
    let loss: ConversionLoss;

    // ── the destination row and its slots ──────────────────────────────
    let dest: Row;
    let created: boolean;
    let slotByIdOnDest: Record<string, string>;
    if (args.attachToId) {
      const attach = await ctx.db.get(args.attachToId);
      if (!attach || attach.level !== "insert" || attach.parentId !== targetType._id) {
        throw new ConvexError(conversionRefusal.attachGone());
      }
      // ANY parallel of the type holding a moving link refuses, not only the
      // one picked (security audit, NEO-305): the same rule as new mode, or
      // the link would land on a second row of one Parallel type.
      const holder = (await insertRowsUnder(ctx, targetType._id)).find((p) =>
        holdsAnyLink(p, sourceRows(source)),
      );
      if (holder) {
        throw new ConvexError(
          conversionRefusal.linkTaken(targetSet.value, holder.value, set.value),
        );
      }
      // Cards landing on a row mid-review would land under a commit that
      // does not know about them (security audit, NEO-305).
      if (await hasOpenReview(ctx, attach._id)) {
        throw new ConvexError(conversionRefusal.reviewOpen(attach.value));
      }
      loss = lossOnto(sourceData, attach);
      const alloc = allocateSlots(attach, {
        sportlots: links.map((l) => ({ id: l.id, label: l.label })),
      });
      await ctx.db.patch(attach._id, {
        platformData: alloc.platformData,
        platformLabels: alloc.platformLabels,
        platformSlotSeq: alloc.platformSlotSeq,
        lastUpdated: now,
      });
      dest = attach;
      created = false;
      slotByIdOnDest = alloc.slotByIdBySide.sportlots;
    } else {
      const siblings = await insertRowsUnder(ctx, targetType._id);
      const check = newParallelCheck(source, targetSet, siblings);
      if (!check.ok) throw new ConvexError(check.reason);
      const flags = derivedVariantFlags("insert", targetType);
      // The set's and Base's operator data comes WITH it onto the new row
      // (security audit, NEO-305): copy-down from the Parallel type first,
      // then what the operator had, then the row's own level derivation.
      const features = {
        ...(targetType.features ?? {}),
        ...sourceData.features,
        ...deriveOwnLevelFeatures("insert", check.name, flags),
      };
      const teamIds = sourceData.teamIds
        ? [...sourceData.teamIds]
        : inheritedTeamIds(targetType);
      const metadata = {
        ...(flags ?? {}),
        ...(sourceData.cardNumberPrefix !== undefined
          ? { cardNumberPrefix: sourceData.cardNumberPrefix }
          : {}),
      };
      loss = lossOnto(sourceData, null);
      const alloc = initialSlots({
        sportlots: links.map((l) => ({ id: l.id, label: l.label })),
      });
      const destId = await ctx.db.insert("selectorOptions", {
        level: "insert",
        value: check.name,
        platformData: alloc.platformData,
        platformLabels: alloc.platformLabels,
        platformSlotSeq: alloc.platformSlotSeq,
        parentId: targetType._id,
        children: [],
        createdByUserId: adminUserId,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(Object.keys(features).length > 0 ? { features } : {}),
        ...(teamIds ? { teamIds } : {}),
        lastUpdated: now,
      });
      await ctx.db.patch(targetType._id, {
        children: unionChildren(targetType.children, [destId]),
      });
      dest = (await ctx.db.get(destId))!;
      created = true;
      slotByIdOnDest = alloc.slotByIdBySide.sportlots;
    }

    // ── cards follow their own links ──────────────────────────────────
    const slotMapFor = (rowId: RowId): Map<string, string> => {
      const map = new Map<string, string>();
      for (const l of links) {
        if (l.from !== rowId) continue;
        const destSlot = slotByIdOnDest[l.id];
        if (destSlot) map.set(l.slot, destSlot);
      }
      return map;
    };
    const baseMap = slotMapFor(base._id);
    const setMap = slotMapFor(set._id);
    await moveCards(
      ctx,
      dest._id,
      [
        // BSC: the source carries no BSC slot (guarded above), so every BSC
        // `src` on these cards is already dangling and is cleared, ref kept.
        ...baseCards.map((card) => ({ card, slotMap: { sportlots: baseMap } })),
        ...setCards.map((card) => ({ card, slotMap: { sportlots: setMap } })),
      ],
      now,
    );
    await moveGuestCrossListings(ctx, guestLinks, dest._id, now);

    // ── end the emptied rows through the trash icon's own helper ──────
    await deleteEmptySelectorOptionRow(ctx, (await ctx.db.get(base._id))!, adminUserId);
    await deleteEmptySelectorOptionRow(ctx, (await ctx.db.get(set._id))!, adminUserId);

    console.log(
      JSON.stringify({
        msg: "set_converted_to_parallel",
        adminUserId,
        setId: set._id,
        baseId: base._id,
        destId: dest._id,
        created,
        links: links.length,
        cards: baseCards.length + setCards.length,
        guests: guestLinks.length,
        // Operator-typed fields the deleted rows carried that the destination
        // does not keep — named to the operator in the dialog before confirm.
        dropped: lossFieldNames(loss),
      }),
    );

    return {
      targetSetId: targetSet._id,
      parallelTypeId: targetType._id,
      parallelId: dest._id,
      parallelValue: dest.value,
      targetSetValue: targetSet.value,
      created,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Part C — "Promote to set"
// ───────────────────────────────────────────────────────────────────────────

type PromotionSource =
  | { ok: false; reason: string }
  | { ok: true; row: Row; set: Row; brand: Row };

/**
 * A row under a set that "Promote to set" can split a SportLots link off
 * (NEO-306 generalised it from NEO-305's parallels of a set):
 *
 *  - an `insert`-level row under any variant type but the Base — a parallel
 *    of the base, an insert, or a row filed under a type with no NB role
 *    (the SportLots-only review files there too, and invariant 6 says a row
 *    without a role behaves like one with);
 *  - a `parallel`-level row under such an insert (row → insert → type).
 *
 * Decided by level and the NB base flag, never by a name. The Base is
 * refused because it is terminal: nothing NB mints sits under it.
 */
async function readPromotionSource(
  ctx: { db: QueryCtx["db"] },
  parallelId: RowId,
): Promise<PromotionSource> {
  const row = await ctx.db.get(parallelId);
  if (!row) return { ok: false, reason: promotionRefusal.rowGone() };
  const notUnderASet = { ok: false as const, reason: promotionRefusal.notAParallel(row.value) };
  let insertRow: Row | null = row;
  if (row.level === "parallel") {
    insertRow = row.parentId ? await ctx.db.get(row.parentId) : null;
  } else if (row.level !== "insert") {
    return notUnderASet;
  }
  if (!insertRow || insertRow.level !== "insert") return notUnderASet;
  const type = insertRow.parentId ? await ctx.db.get(insertRow.parentId) : null;
  if (!type || type.level !== "variantType" || variantTypeRole(type) === "base") {
    return notUnderASet;
  }
  const set = type.parentId ? await ctx.db.get(type.parentId) : null;
  const brand = set?.parentId ? await ctx.db.get(set.parentId) : null;
  if (!set || set.level !== "setName" || !brand || brand.level !== "manufacturer") {
    return { ok: false, reason: promotionRefusal.noBrand() };
  }
  return { ok: true, row, set, brand };
}

/**
 * Whether "Promote to set" is offered on a row, and which SportLots links it
 * can promote (each with its label, for the picker when there are several).
 */
export const getParallelPromotionEligibility = query({
  args: { parallelId: v.id("selectorOptions") },
  returns: v.union(
    v.object({ eligible: v.literal(false) }),
    v.object({
      eligible: v.literal(true),
      links: v.array(v.object({ slot: v.string(), label: v.string() })),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await readPromotionSource(ctx, args.parallelId);
    if (!source.ok) return { eligible: false as const };
    const links = slotEntries(source.row, "sportlots").map(({ slot }) => ({
      slot,
      label: slotLabel(source.row, "sportlots", slot),
    }));
    if (links.length === 0) return { eligible: false as const };
    return { eligible: true as const, links };
  },
});

/**
 * The dialog's read for one link: the set it would become, and whether that
 * name is already a set in the brand (the dialog then offers "add to that
 * set's Base"). Asked only while the dialog is open.
 */
export const getParallelPromotionPreview = query({
  args: {
    parallelId: v.id("selectorOptions"),
    slSlotKey: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({
      ok: v.literal(true),
      rowValue: v.string(),
      brandValue: v.string(),
      setName: v.string(),
      cardCount: v.number(),
      /** The row stays: something is left on it after the link goes. */
      rowStays: v.boolean(),
      clash: v.optional(
        v.object({
          setId: v.id("selectorOptions"),
          value: v.string(),
          hasBase: v.boolean(),
          /** That set's Base already holds the link; adding is refused too. */
          holdsLink: v.boolean(),
        }),
      ),
      /** Why the promote would refuse, when it would regardless of choice. */
      refusal: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await readPromotionSource(ctx, args.parallelId);
    if (!source.ok) return { ok: false as const, reason: source.reason };
    const { row, brand } = source;
    const id = isSlotKeyForSide("sportlots", args.slSlotKey)
      ? idForSlot(row, "sportlots", args.slSlotKey)
      : undefined;
    if (id === undefined) {
      return { ok: false as const, reason: promotionRefusal.linkGone(row.value) };
    }
    const label = slotLabel(row, "sportlots", args.slSlotKey);
    const { defaultName } = candidateDefaultName(label, brand.metadata?.setNamePrefix);

    const cards = await cardsOn(ctx, row._id, MAX_CARDS_PER_ROW_READ + 1);
    const { moving, paired } = splitCardsForSlot(row, cards, args.slSlotKey);
    const leftOnRow =
      slotIds(row, "bsc").length > 0 ||
      slotIds(row, "sportlots").length > 1 ||
      cards.length > moving.length ||
      (await childrenOf(ctx, row._id, 1)).length > 0;

    let refusal: string | undefined;
    if (paired > 0) refusal = promotionRefusal.paired(row.value, paired);
    else if (moving.length > MAX_CARDS_PER_MOVE || cards.length > MAX_CARDS_PER_ROW_READ) {
      refusal = promotionRefusal.tooManyCards(row.value, MAX_CARDS_PER_MOVE);
    }

    const checked = checkCustomSelectorValue("setName", defaultName);
    let clash:
      | { setId: RowId; value: string; hasBase: boolean; holdsLink: boolean }
      | undefined;
    if (checked.ok) {
      const { byKey, truncated } = await brandSetsByKey(ctx, brand._id);
      if (truncated) refusal ??= promotionRefusal.tooManySets(brand.value);
      const hit = byKey.get(selectorValueKey(checked.value));
      if (hit) {
        const hitBase = await baseOf(ctx, hit._id);
        clash = {
          setId: hit._id,
          value: hit.value,
          hasBase: hitBase !== null,
          holdsLink: hitBase ? slotIds(hitBase, "sportlots").includes(id) : false,
        };
      }
    } else {
      refusal ??= promotionRefusal.badName(checked.reason);
    }

    return {
      ok: true as const,
      rowValue: row.value,
      brandValue: brand.value,
      setName: checked.ok ? checked.value : defaultName,
      cardCount: moving.length,
      rowStays: leftOnRow,
      ...(clash ? { clash } : {}),
      ...(refusal ? { refusal } : {}),
    };
  },
});

/**
 * NEO-305 Part C — "Promote to set", the way back from Part B — and, since
 * NEO-306, from "Make insert of…": `parallelId` is any row
 * `readPromotionSource` accepts (an insert-level row, or a parallel of one).
 *
 * One SportLots link (`slSlotKey`) on a parallel row becomes a set under the
 * same brand: a set and Base minted by `insertSetWithBaseFromSl` — the exact
 * shape the Sync Sets SportLots phase writes — named by
 * `candidateDefaultName`, the Base holding the link with its id and label.
 * With `attachToSetId` the link goes onto that set's Base instead (the
 * answer to a name clash). The cards attributed to the link move with it.
 *
 * The link leaves the parallel. The row itself is deleted only when nothing
 * is left on it — no link on either marketplace, no card, no row under it,
 * nothing listed in it — so a row still holding a BSC link stays as BSC's
 * parallel. Links are never dropped in either direction.
 */
export const promoteParallelToSet = mutation({
  args: {
    parallelId: v.id("selectorOptions"),
    slSlotKey: v.string(),
    attachToSetId: v.optional(v.id("selectorOptions")),
  },
  returns: v.object({
    setId: v.id("selectorOptions"),
    baseId: v.id("selectorOptions"),
    setValue: v.string(),
    created: v.boolean(),
    parallelKept: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const adminUserId = await requireAdmin(ctx);
    const source = await readPromotionSource(ctx, args.parallelId);
    if (!source.ok) throw new ConvexError(source.reason);
    const { row, brand } = source;

    // A SportLots slot key and nothing else (security audit, NEO-305): a
    // client-sent string never reaches the slot maps unless it is one.
    if (!isSlotKeyForSide("sportlots", args.slSlotKey)) {
      throw new ConvexError(promotionRefusal.linkGone(row.value));
    }
    const id = idForSlot(row, "sportlots", args.slSlotKey);
    if (id === undefined) {
      throw new ConvexError(promotionRefusal.linkGone(row.value));
    }
    const label = slotLabel(row, "sportlots", args.slSlotKey);

    if (await hasOpenReview(ctx, row._id)) {
      throw new ConvexError(promotionRefusal.reviewOpen(row.value));
    }
    // Read past the move bound so the link's share can be counted: a row
    // holding cards for several links may hold more than one move carries in
    // total. Beyond this read the split cannot be judged at all, so it
    // refuses rather than leave cards behind on a link that has gone.
    const cards = await cardsOn(ctx, row._id, MAX_CARDS_PER_ROW_READ + 1);
    if (cards.length > MAX_CARDS_PER_ROW_READ) {
      throw new ConvexError(promotionRefusal.tooManyCards(row.value, MAX_CARDS_PER_MOVE));
    }
    const { moving, paired } = splitCardsForSlot(row, cards, args.slSlotKey);
    if (paired > 0) throw new ConvexError(promotionRefusal.paired(row.value, paired));
    if (moving.length > MAX_CARDS_PER_MOVE) {
      throw new ConvexError(promotionRefusal.tooManyCards(row.value, MAX_CARDS_PER_MOVE));
    }

    const now = Date.now();
    let setId: RowId;
    let setValue: string;
    let base: Row;
    let created: boolean;
    let destSlot: string;

    if (args.attachToSetId) {
      const target = await ctx.db.get(args.attachToSetId);
      if (!target || target.level !== "setName") {
        throw new ConvexError(promotionRefusal.attachGone());
      }
      if (target.parentId !== brand._id) {
        throw new ConvexError(promotionRefusal.attachOtherBrand(target.value, brand.value));
      }
      const targetBase = await baseOf(ctx, target._id);
      if (!targetBase) throw new ConvexError(promotionRefusal.attachNoBase(target.value));
      if (slotIds(targetBase, "sportlots").includes(id)) {
        throw new ConvexError(promotionRefusal.linkTaken(target.value, row.value));
      }
      if (await hasOpenReview(ctx, targetBase._id)) {
        throw new ConvexError(promotionRefusal.reviewOpen(target.value));
      }
      const alloc = allocateSlots(targetBase, { sportlots: [{ id, label }] });
      await ctx.db.patch(targetBase._id, {
        platformData: alloc.platformData,
        platformLabels: alloc.platformLabels,
        platformSlotSeq: alloc.platformSlotSeq,
        lastUpdated: now,
      });
      setId = target._id;
      setValue = target.value;
      base = targetBase;
      created = false;
      destSlot = alloc.slotByIdBySide.sportlots[id];
    } else {
      const { defaultName } = candidateDefaultName(label, brand.metadata?.setNamePrefix);
      const { byKey, truncated } = await brandSetsByKey(ctx, brand._id);
      if (truncated) throw new ConvexError(promotionRefusal.tooManySets(brand.value));
      const clash = byKey.get(selectorValueKey(defaultName.trim()));
      if (clash) {
        throw new ConvexError(promotionRefusal.nameTaken(brand.value, clash.value));
      }
      const minted = await insertSetWithBaseFromSl(ctx, {
        brandId: brand._id,
        name: defaultName,
        sl: { id, label },
        createdByUserId: adminUserId,
      });
      if (!minted.ok) {
        switch (minted.reason) {
          case "clash_at_target":
            throw new ConvexError(promotionRefusal.nameTaken(brand.value, minted.value));
          case "exists_elsewhere":
            throw new ConvexError(
              promotionRefusal.existsElsewhere(
                minted.matches[0].value,
                minted.matches[0].brand,
                brand.value,
              ),
            );
          case "invalid_name":
            throw new ConvexError(promotionRefusal.badName(minted.detail));
          case "brand_missing":
          case "index_truncated":
            throw new ConvexError(promotionRefusal.noBrand());
        }
      }
      const fresh = (await ctx.db.get(minted.baseId))!;
      setId = minted.setId;
      setValue = (await ctx.db.get(minted.setId))!.value;
      base = fresh;
      created = true;
      destSlot = slotForId(fresh, "sportlots", id)!;
    }

    // ── the cards attributed to the link follow it ─────────────────────
    await moveCards(
      ctx,
      base._id,
      moving.map((card) => ({
        card,
        slotMap: { sportlots: new Map([[args.slSlotKey, destSlot]]) },
      })),
      now,
    );

    // ── the link leaves the parallel ───────────────────────────────────
    const detached = detachSlot(row, "sportlots", args.slSlotKey);
    const primary = { ...(row.primaryPlatformId ?? {}) };
    if (primary.sportlots === args.slSlotKey) delete primary.sportlots;
    await ctx.db.patch(row._id, {
      platformData: detached.platformData,
      platformLabels: detached.platformLabels,
      primaryPlatformId: Object.keys(primary).length > 0 ? primary : undefined,
      lastUpdated: now,
    });

    // ── and the row goes only when nothing is left on it ────────────────
    const after = (await ctx.db.get(row._id))!;
    const linked =
      slotIds(after, "bsc").length > 0 || slotIds(after, "sportlots").length > 0;
    const holds = linked ? [] : await collectSelectorOptionHoldings(ctx, after);
    const parallelKept = linked || holds.length > 0;
    if (!parallelKept) {
      await deleteEmptySelectorOptionRow(ctx, after, adminUserId);
    }

    console.log(
      JSON.stringify({
        msg: "parallel_promoted_to_set",
        adminUserId,
        parallelId: row._id,
        setId,
        baseId: base._id,
        created,
        parallelKept,
        cards: moving.length,
      }),
    );

    return { setId, baseId: base._id, setValue, created, parallelKept };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// The Parallels sync's filter (coordinator, NEO-305)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rows one brand walk reads before it stops and says so — the same ceiling
 * `listBrandSubtreeSlIds` walks a brand under (`MAX_SYNC_ITEMS`).
 */
export const MAX_BRAND_HOLDER_ROWS = 2000;

/**
 * Every row ELSEWHERE in a variant type's brand — under any set but its own —
 * that holds a SportLots link, with the NB name the operator knows it by.
 *
 * Why: a Parallels (or Inserts) sync asks SportLots for the brand's whole
 * list, and the forms only ever held back ids used within the SAME set
 * (`getUsedInsertIdentifiersBySet`). So "Bowman Blue", a set whose Base
 * already holds that SportLots id, came back as a fresh candidate for
 * Bowman's Parallels — and taking it put one SportLots id on two rows. The
 * form now holds these ids back exactly as it holds back a grouped parallel's
 * (NEO-300's `heldElsewhere`): not offered, not auto-matched, and named in a
 * note so the operator can fold the set in with "Make parallel of…".
 *
 * Keyed by id; the names are NB names, for display only. Bounded by
 * `MAX_BRAND_HOLDER_ROWS` rows read; `truncated` says the list is partial.
 */
export const getBrandSlHolders = query({
  args: { variantTypeId: v.id("selectorOptions") },
  returns: v.object({
    rows: v.array(
      v.object({
        key: v.string(),
        name: v.string(),
        sportlots: v.array(v.string()),
      }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const empty = { rows: [], truncated: false };
    const type = await ctx.db.get(args.variantTypeId);
    const ownSet = type?.parentId ? await ctx.db.get(type.parentId) : null;
    const brand = ownSet?.parentId ? await ctx.db.get(ownSet.parentId) : null;
    if (!type || !ownSet || !brand || brand.level !== "manufacturer") return empty;

    const rows: Array<{ key: string; name: string; sportlots: string[] }> = [];
    let read = 0;
    const take = async (parentId: RowId) => {
      const remaining = MAX_BRAND_HOLDER_ROWS - read;
      if (remaining <= 0) return null;
      const children = await ctx.db
        .query("selectorOptions")
        .withIndex("by_parent", (q) => q.eq("parentId", parentId))
        .take(remaining + 1);
      if (children.length > remaining) return null;
      read += children.length;
      return children;
    };

    const sets = await take(brand._id);
    if (sets === null) return { rows, truncated: true };
    for (const set of sets) {
      if (set._id === ownSet._id || set.level !== "setName") continue;
      // Breadth-first under one set, naming each row by the set it is in.
      let frontier: Array<{ row: Row; name: string }> = [{ row: set, name: set.value }];
      while (frontier.length > 0) {
        const next: Array<{ row: Row; name: string }> = [];
        for (const { row, name } of frontier) {
          const ids = slotIds(row, "sportlots");
          if (ids.length > 0) rows.push({ key: String(row._id), name, sportlots: ids });
          if (row.level === "parallel") continue;
          const children = await take(row._id);
          if (children === null) return { rows, truncated: true };
          for (const child of children) {
            // A Base IS the set to an operator ("Bowman Blue"); any other
            // row reads as the set plus its own name ("Bowman Chrome Gold").
            const childName =
              child.level === "variantType" && child.metadata?.isBase === true
                ? set.value
                : `${set.value} ${child.value}`;
            next.push({ row: child, name: childName });
          }
        }
        frontier = next;
      }
    }
    return { rows, truncated: false };
  },
});
