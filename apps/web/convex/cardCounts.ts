/**
 * NEO-358 — `selectorOptions.cardCount` and `nonVariationCardCount`: how many
 * `cardChecklist` rows point at a row, kept so a collector's "1 of N" never
 * reads a whole checklist.
 *
 * ## Two counts (Jason, 2026-10-23)
 *
 *  - `cardCount`: every home row, variations included;
 *  - `nonVariationCardCount`: home rows WITHOUT `variationOfCardId`, the base
 *    count the UI shows by default.
 *
 * So the second count moves on a card insert or delete AND on any write that
 * sets or clears `variationOfCardId` on a card that stays put
 * (`setCardVariationParent`, the commit finalize's variation pass,
 * `orphanVariationsOf` promoting a deleted parent's children). Every such
 * writer owns a ledger and flushes it.
 *
 * ## The ledger
 *
 * Every mutation that inserts, deletes or moves a card, or changes a card's
 * variation parent, owns one `CardCountLedger`. Each write adds its deltas
 * (`addCard`, `removeCard`, `variationChanged`, or the raw `add`) and the
 * mutation calls `await ledger.flush(ctx)` ONCE, at the end of the
 * transaction. Deltas, not recounts: a commit chunk that inserts 900 cards
 * patches the variant row once and never reads the checklist it just wrote.
 *
 * `flush` patches `count = stored + delta` for both counts and skips a row
 * whose deltas are both zero. Two cases recount BOTH instead, in place, inside
 * the same transaction (so the count includes this mutation's own writes):
 *
 *  - either stored count is ABSENT: the row was never counted (written before
 *    these fields, and not reached by the backfill yet);
 *  - either `stored + delta` would go NEGATIVE: the stored count has drifted.
 *    The recount repairs it and logs `card_count_drift`.
 *
 * A recount is bounded (`RECOUNT_MAX`). A row past it is left exactly as it
 * stood and logged `card_count_recount_skipped`; the armed backfill
 * (`backfillVariantCardCounts`) is the tool for a row that big.
 *
 * Concurrent chunks on one variant serialise on the variant row itself: each
 * flush reads and patches it, so OCC retries the loser.
 *
 * ## Subtree counts (Jason, 2026-10-24) and `hasCards` (NEO-364, 2026-10-25)
 *
 * Jason, final: "Exact counts from the set down, a one-time has-cards flag on
 * sport, year and brand, hide anything without it, and drop counts from the
 * selector."
 *
 * `subtreeCardCount` / `subtreeNonVariationCardCount`: the cards on a row OR
 * anywhere beneath it, kept from the SET row down, so each of those steps of
 * the collector's drill knows whether anything sits below it and an exact
 * zero is hidden (`collectionCatalog.drill`, `setSummary`, set suggestions).
 *
 * `hasCards`, on sport, year and manufacturer rows only (`HAS_CARDS_LEVELS`):
 * set true by the first flush that carries an ADDED card (or a re-homed
 * subtree with cards or of unknown size) up to the row, and never written by
 * the ledger again. Never false, never cleared when the cards go. Absent
 * means hidden from the drill.
 *
 * The same flush carries every row's delta up its `parentId` chain: each row
 * a delta reaches (the card's row, then insert / variant type / set) is read
 * ONCE and patched at most ONCE per flush, own and subtree counts in one
 * patch, however many cards and rows the mutation touched; the brand, year
 * and sport above it are read, and patched only for their first card. The
 * rules:
 *
 *  - an ABSENT subtree count stays absent (UNKNOWN). It is never recounted in
 *    a mutation and never written partially; `backfillSubtreeCardCounts`
 *    fills it. A new row from the set down is born at 0
 *    (`newRowSubtreeCounts(level)`, spread into every selector-row insert),
 *    so only rows from before this field and rows the ledger cleared are ever
 *    unknown;
 *  - a subtree count that would go negative (or a base count that would pass
 *    the all-cards count) has drifted: it is cleared to UNKNOWN and logged
 *    `subtree_card_count_drift`, never clamped (a clamp claims "nothing
 *    below" exactly where the count is known wrong, and would hide cards);
 *  - a row deleted in the same transaction still passes its delta up:
 *    `removeCardRow` calls `rememberChain` while the row exists, and the
 *    flush walks a vanished row through that remembered parent;
 *  - a writer that RE-PARENTS a row calls `moveSubtree` (`brandRehome`'s
 *    set re-home, `applyParallelGroupings`): the row's stored subtree leaves
 *    the old chain and joins the new one, shared ancestors net to zero. A
 *    row of unknown size makes every row on one chain and not the other
 *    unknown (`subtree_card_count_unknown_move`). The new chain's sport,
 *    year and brand get `hasCards` when the moved subtree has cards or is of
 *    unknown size; the old chain's are left as they are.
 *
 * Cost: one read per ancestor per flush (six or seven rows for a card under
 * a set), and one patch per row from the card's row up to its set. The
 * brand, year and sport rows are patched once in their lives, by the first
 * card beneath them, so concurrent card writers in different sets of one
 * sport no longer collide there (NEO-358 wrote all three on every card
 * write, and every concurrent set build serialised on the sport row).
 * Writers inside ONE set still serialise on the set row.
 *
 * ## What it counts
 *
 * Home rows only (`by_selector_option`); a cross-listed guest is not a card OF
 * the row.
 *
 * ## Writers
 *
 * `cardCounts.pin.test.ts` greps every card insert, delete and move, every
 * `variationOfCardId` write, every selector-row re-parent and every
 * selector-row insert for its ledger (or its `newRowSubtreeCounts`). The
 * one exemption is the E2E reset drain (`selectorOptions.resetCardChecklistBatch`),
 * which drains the selector rows too.
 *
 * ## Operator command (the backfill)
 *
 *   # 1. dry run: reports what an armed run would write, writes nothing
 *   npx convex run cardCounts:backfillVariantCardCounts '{}'
 *
 *   # 2. arm the deployment, run for real, disarm
 *   npx convex env set ALLOW_CARD_COUNT_BACKFILL 1
 *   npx convex run cardCounts:backfillVariantCardCounts '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_CARD_COUNT_BACKFILL
 *
 *   # production: the same three steps with --prod. Re-run until the report
 *   # says "complete": true; pass the returned `cursor` back to resume.
 *   # `"repair": true` also rewrites a stored count that disagrees with the
 *   # recount (by default only an ABSENT count is filled).
 *
 *   # THEN the subtree counts, bottom-up from the own counts above. Same
 *   # shape, its own arm; run only after the first reports "complete": true.
 *   npx convex run cardCounts:backfillSubtreeCardCounts '{}'
 *   npx convex env set ALLOW_SUBTREE_CARD_COUNT_BACKFILL 1
 *   npx convex run cardCounts:backfillSubtreeCardCounts '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_SUBTREE_CARD_COUNT_BACKFILL
 *
 *   # Re-run until "complete": true AND "waiting": 0 (a waiting row's child
 *   # was still unknown). A dry run cannot fill a level for the one above it,
 *   # so its upper levels report as waiting. `"repair": true` rewrites a
 *   # stored subtree count that disagrees with the sum of its children.
 *   # NEO-364: the same run sets `hasCards` on every sport, year and brand
 *   # with cards (or a set of unknown count) below, unsets it where there
 *   # are none, and clears their old subtree counts (`flagsSet`,
 *   # `flagsCleared`, `staleCountsCleared`). Until it has run, a sport, year
 *   # or brand whose cards were written before NEO-364 is hidden.
 *
 * See docs/operations/neo358-backfill-card-search-fields.md.
 */

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

/**
 * The most cards a recount reads for one row inside a mutation that is doing
 * other work. The backfill's per-row ceiling, so a row the ledger cannot count
 * is exactly a row the backfill refuses too.
 */
export const RECOUNT_MAX = 10_000;

type CountCtx = { db: MutationCtx["db"] };

/** Both counts for one row. */
export type CardCounts = { cardCount: number; nonVariationCardCount: number };

/** Both counts of the cards pointing at `rowId`, or `null` past `RECOUNT_MAX`. */
export async function recountCards(
  ctx: CountCtx,
  rowId: Id<"selectorOptions">,
): Promise<CardCounts | null> {
  const rows = await ctx.db
    .query("cardChecklist")
    .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", rowId))
    .take(RECOUNT_MAX + 1);
  if (rows.length > RECOUNT_MAX) return null;
  let nonVariationCardCount = 0;
  for (const row of rows) {
    if (row.variationOfCardId === undefined) nonVariationCardCount++;
  }
  return { cardCount: rows.length, nonVariationCardCount };
}

type Delta = { all: number; nonVariation: number };

/** What `addCard` / `removeCard` read off a card. */
type CountedCard = Pick<Doc<"cardChecklist">, "selectorOptionId" | "variationOfCardId">;

type RowId = Id<"selectorOptions">;
type Row = Doc<"selectorOptions">;

/** Both subtree counts for one row. */
export type SubtreeCounts = {
  subtreeCardCount: number;
  subtreeNonVariationCardCount: number;
};

/**
 * NEO-364 — the levels that carry the one-time `hasCards` flag instead of
 * subtree counts. Every other level (the set and below) keeps exact subtree
 * counts.
 */
export const HAS_CARDS_LEVELS: ReadonlySet<Row["level"]> = new Set<Row["level"]>([
  "sport",
  "year",
  "manufacturer",
]);

/** True for a sport, year or manufacturer row (see `HAS_CARDS_LEVELS`). */
export function carriesHasCards(level: Row["level"]): boolean {
  return HAS_CARDS_LEVELS.has(level);
}

const KNOWN_EMPTY_SUBTREE: SubtreeCounts = {
  subtreeCardCount: 0,
  subtreeNonVariationCardCount: 0,
};

/**
 * What a new `selectorOptions` row of `level` is born with. From the set
 * down: both subtree counts at 0 (nothing points at a brand-new id, so its
 * subtree is known to be empty; a row born without them would read as
 * UNKNOWN until the backfill reached it). A sport, year or manufacturer row
 * is born with nothing: no subtree counts, and no `hasCards`, so it stays out
 * of the collector's drill until a card lands beneath it. Spread first into
 * every selector-row insert, with the row's own level (pinned by
 * `cardCounts.pin.test.ts`).
 */
export function newRowSubtreeCounts(
  level: Row["level"],
): SubtreeCounts | Record<string, never> {
  return carriesHasCards(level) ? {} : { ...KNOWN_EMPTY_SUBTREE };
}

/**
 * Hops an ancestor walk takes before giving up. The tree is seven levels deep
 * (sport → parallel); anything longer is a `parentId` cycle.
 */
const MAX_CHAIN_DEPTH = 12;

const isZero = (d: Delta) => d.all === 0 && d.nonVariation === 0;

/**
 * One mutation's card-count deltas, per selector row. See the header.
 */
export class CardCountLedger {
  private readonly deltas = new Map<RowId, Delta>();
  /**
   * Subtree-only deltas that start at a row and run up its chain: a moved
   * row's subtree leaving its old parent and landing on its new one.
   */
  private chainDeltas: Array<{ from: RowId; delta: Delta }> = [];
  /** Moves of a row whose subtree size is unknown; see `moveSubtree`. */
  private unknownMoves: Array<{ from: RowId | undefined; to: RowId | undefined }> = [];
  /**
   * NEO-364 — chains (from the given row up) whose sport, year and
   * manufacturer rows must carry `hasCards`: a re-homed sport, year or
   * manufacturer row that itself carries the flag lands under them.
   */
  private flagChains: RowId[] = [];
  /**
   * Row → parent (null at the root), learned while the row still existed, so
   * a row deleted later in the same transaction still passes its delta up.
   * Consulted only for a row `flush` cannot read: a live row's own
   * `parentId` always wins.
   */
  private readonly parentHints = new Map<RowId, RowId | null>();

  /**
   * Raw deltas: `all` cards added to (negative: removed from) `rowId`, of
   * which `nonVariation` were not variations.
   */
  add(rowId: RowId, all: number, nonVariation: number): void {
    if (all === 0 && nonVariation === 0) return;
    const held = this.deltas.get(rowId) ?? { all: 0, nonVariation: 0 };
    this.deltas.set(rowId, {
      all: held.all + all,
      nonVariation: held.nonVariation + nonVariation,
    });
  }

  /** A card row was inserted (or moved IN), as it now stands. */
  addCard(card: CountedCard): void {
    this.add(card.selectorOptionId, 1, card.variationOfCardId === undefined ? 1 : 0);
  }

  /** A card row was deleted (or moved OUT), as it stood. */
  removeCard(card: CountedCard): void {
    this.add(card.selectorOptionId, -1, card.variationOfCardId === undefined ? -1 : 0);
  }

  /**
   * A card that stays on `rowId` gained or lost its variation parent. Only the
   * transition counts: re-parenting a variation onto another parent is no
   * change.
   */
  variationChanged(
    rowId: RowId,
    wasVariation: boolean,
    isVariation: boolean,
  ): void {
    if (wasVariation === isVariation) return;
    this.add(rowId, 0, isVariation ? -1 : 1);
  }

  /** The pending deltas for one row; for tests and logging. */
  deltaFor(rowId: RowId): Delta {
    return this.deltas.get(rowId) ?? { all: 0, nonVariation: 0 };
  }

  /**
   * Learn `rowId`'s ancestor chain NOW, while every row on it exists, so the
   * flush can still walk it if the row (or an ancestor) is deleted before
   * then: an emptied row ended through `deleteEmptySelectorOptionRow` in the
   * same transaction. `removeCardRow` calls it for every card it deletes;
   * once per row per ledger, a handful of reads.
   */
  async rememberChain(ctx: CountCtx, rowId: RowId): Promise<void> {
    let cur: RowId | undefined = rowId;
    for (let hops = 0; cur !== undefined && hops < MAX_CHAIN_DEPTH; hops++) {
      if (this.parentHints.has(cur)) return;
      const doc: Row | null = await ctx.db.get(cur);
      if (!doc) return;
      this.parentHints.set(cur, doc.parentId ?? null);
      cur = doc.parentId;
    }
  }

  /**
   * `rowId` was (or is about to be) re-parented from `fromParentId` to
   * `toParentId`: its whole subtree leaves the old chain and joins the new
   * one. Reads the row's STORED subtree counts now; card deltas still pending
   * in this ledger are applied at flush to whichever chain the row then sits
   * on, so the two compose in any order. Ancestors the two chains share net
   * to zero and are not written.
   *
   * A row whose subtree count is UNKNOWN cannot be moved by a delta: every
   * row on one chain and not the other is set unknown at flush (logged
   * `subtree_card_count_unknown_move`) for the backfill to refill.
   *
   * NEO-364 — the new chain's sport, year and manufacturer rows get
   * `hasCards` when the moved subtree holds cards OR its size is unknown
   * (showing a level is safe; hiding one with cards is not). The old chain's
   * flags are never cleared. A moved row that is itself a sport, year or
   * manufacturer row carries no subtree counts: its own `hasCards` is what
   * travels.
   */
  async moveSubtree(
    ctx: CountCtx,
    rowId: RowId,
    fromParentId: RowId | undefined,
    toParentId: RowId | undefined,
  ): Promise<void> {
    if (fromParentId === toParentId) return;
    if (fromParentId) await this.rememberChain(ctx, fromParentId);
    const row = await ctx.db.get(rowId);
    if (row && carriesHasCards(row.level)) {
      if (row.hasCards === true && toParentId) this.flagChains.push(toParentId);
      return;
    }
    const all = row?.subtreeCardCount;
    const base = row?.subtreeNonVariationCardCount;
    if (all === undefined || base === undefined) {
      this.unknownMoves.push({ from: fromParentId, to: toParentId });
      return;
    }
    if (all === 0 && base === 0) return;
    if (fromParentId) {
      this.chainDeltas.push({ from: fromParentId, delta: { all: -all, nonVariation: -base } });
    }
    if (toParentId) {
      this.chainDeltas.push({ from: toParentId, delta: { all, nonVariation: base } });
    }
  }

  /**
   * Write every non-zero delta, once, and clear the ledger (a second flush is
   * a no-op). Call it last in the transaction, after every card write and
   * every move.
   *
   * Each row a delta reaches (its own row, and every ancestor up the
   * `parentId` chain) is read once and patched at most once, own counts and
   * subtree counts together. A sport, year or manufacturer row is only READ,
   * unless this flush is the first to bring it a card: then it is patched
   * `hasCards: true`, once, ever (NEO-364).
   */
  async flush(ctx: CountCtx): Promise<void> {
    const own = [...this.deltas.entries()].filter(([, d]) => !isZero(d));
    this.deltas.clear();
    const chainDeltas = this.chainDeltas;
    this.chainDeltas = [];
    const unknownMoves = this.unknownMoves;
    this.unknownMoves = [];
    const flagChains = this.flagChains;
    this.flagChains = [];
    if (
      own.length === 0 &&
      chainDeltas.length === 0 &&
      unknownMoves.length === 0 &&
      flagChains.length === 0
    ) {
      return;
    }

    const docs = new Map<RowId, Row | null>();
    const read = async (id: RowId): Promise<Row | null> => {
      if (!docs.has(id)) docs.set(id, await ctx.db.get(id));
      return docs.get(id) ?? null;
    };
    /** `start` and every ancestor, as the tree stands now. */
    const chainOf = async (start: RowId): Promise<RowId[]> => {
      const out: RowId[] = [];
      const seen = new Set<RowId>();
      let cur: RowId | undefined = start;
      while (cur !== undefined && !seen.has(cur) && out.length < MAX_CHAIN_DEPTH) {
        seen.add(cur);
        out.push(cur);
        const doc = await read(cur);
        if (doc) {
          cur = doc.parentId;
          continue;
        }
        const hint = this.parentHints.get(cur);
        if (hint === undefined) {
          // Gone, and never remembered: its ancestors cannot be reached, so
          // their subtree counts keep this delta (too HIGH: a level shown,
          // never one hidden). The repair backfill fixes it.
          console.warn(
            JSON.stringify({ msg: "subtree_card_count_chain_lost", selectorOptionId: cur }),
          );
        }
        cur = hint ?? undefined;
      }
      return out;
    };

    const subtree = new Map<RowId, Delta>();
    const bump = (id: RowId, d: Delta) => {
      const held = subtree.get(id) ?? { all: 0, nonVariation: 0 };
      subtree.set(id, { all: held.all + d.all, nonVariation: held.nonVariation + d.nonVariation });
    };
    // NEO-364 — rows some ADDED card (or moved-in subtree with cards, or of
    // unknown size) reaches. Judged per contribution, not on the net delta:
    // a flush that adds a card in one set and removes one in another nets
    // to zero at the sport, but a card still landed beneath it.
    const gained = new Set<RowId>();
    for (const [rowId, d] of own) {
      const chain = await chainOf(rowId);
      for (const id of chain) bump(id, d);
      if (d.all > 0) for (const id of chain) gained.add(id);
    }
    for (const { from, delta } of chainDeltas) {
      const chain = await chainOf(from);
      for (const id of chain) bump(id, delta);
      if (delta.all > 0) for (const id of chain) gained.add(id);
    }
    const unknown = new Set<RowId>();
    for (const { from, to } of unknownMoves) {
      const left = from ? await chainOf(from) : [];
      const right = to ? await chainOf(to) : [];
      const inLeft = new Set(left);
      const inRight = new Set(right);
      for (const id of left) if (!inRight.has(id)) unknown.add(id);
      for (const id of right) if (!inLeft.has(id)) unknown.add(id);
      // A subtree of unknown size may hold cards: its new chain shows.
      for (const id of right) gained.add(id);
    }
    for (const from of flagChains) {
      for (const id of await chainOf(from)) gained.add(id);
    }

    const ownById = new Map(own);
    const ids = new Set<RowId>([
      ...ownById.keys(),
      ...subtree.keys(),
      ...unknown,
      ...gained,
    ]);
    for (const id of ids) {
      const row = await read(id);
      // The row went in this same transaction (an emptied row ended through
      // `deleteEmptySelectorOptionRow`): there is nothing to count onto. Its
      // ancestors were still reached above, through `parentHints`.
      if (!row) continue;
      if (carriesHasCards(row.level)) {
        // Sport, year, manufacturer: no subtree counts are kept here, and the
        // row is written at most once in its life (NEO-364). No card sits on
        // these levels, so there is no own count to keep either.
        if (gained.has(id) && row.hasCards !== true) {
          await ctx.db.patch(id, { hasCards: true });
        }
        continue;
      }
      const patch: Partial<Row> = {};
      const ownDelta = ownById.get(id);
      if (ownDelta) {
        const next = await nextOwnCounts(ctx, row, ownDelta);
        if (
          next &&
          (next.cardCount !== row.cardCount ||
            next.nonVariationCardCount !== row.nonVariationCardCount)
        ) {
          Object.assign(patch, next);
        }
      }
      Object.assign(patch, nextSubtreeCounts(row, subtree.get(id), unknown.has(id)));
      if (Object.keys(patch).length > 0) await ctx.db.patch(id, patch);
    }
  }
}

/**
 * A row's own counts after `delta`, or null to leave them as they stand. See
 * the header: an absent or would-be-negative count is recounted in place.
 */
async function nextOwnCounts(
  ctx: CountCtx,
  row: Row,
  delta: Delta,
): Promise<CardCounts | null> {
  const stored = row.cardCount;
  const storedBase = row.nonVariationCardCount;
  if (
    stored !== undefined &&
    storedBase !== undefined &&
    stored + delta.all >= 0 &&
    storedBase + delta.nonVariation >= 0
  ) {
    return {
      cardCount: stored + delta.all,
      nonVariationCardCount: storedBase + delta.nonVariation,
    };
  }
  const counted = await recountCards(ctx, row._id);
  if (counted === null) {
    console.warn(
      JSON.stringify({
        msg: "card_count_recount_skipped",
        selectorOptionId: row._id,
        limit: RECOUNT_MAX,
      }),
    );
    return null;
  }
  if (stored !== undefined && storedBase !== undefined) {
    console.warn(
      JSON.stringify({
        msg: "card_count_drift",
        selectorOptionId: row._id,
        stored,
        storedBase,
        delta: delta.all,
        deltaBase: delta.nonVariation,
        counted: counted.cardCount,
        countedBase: counted.nonVariationCardCount,
      }),
    );
  }
  return counted;
}

/** Patch fields that clear both subtree counts (absent = unknown). */
const UNKNOWN_SUBTREE: Partial<Row> = {
  subtreeCardCount: undefined,
  subtreeNonVariationCardCount: undefined,
};

/**
 * The subtree-count fields to patch on `row`, or `{}` for none.
 *
 *  - A row a move of unknown size touched becomes unknown.
 *  - An ABSENT count stays absent: no recount inside a mutation, no partial.
 *    (A row holding only one of the two is cleared to absent, never patched.)
 *  - A count that would go negative, or a base count that would pass the
 *    all-cards count, has drifted: it is cleared to UNKNOWN (shown, never
 *    hidden) and logged `subtree_card_count_drift`; the repair backfill
 *    (`backfillSubtreeCardCounts` with `repair`) rewrites it. Clamping to 0
 *    would claim "no cards below" exactly where the count is known to be
 *    wrong, and would hide a level that may hold cards.
 */
function nextSubtreeCounts(
  row: Row,
  delta: Delta | undefined,
  unknown: boolean,
): Partial<Row> {
  const stored = row.subtreeCardCount;
  const storedBase = row.subtreeNonVariationCardCount;
  const anyStored = stored !== undefined || storedBase !== undefined;
  if (unknown) {
    if (!anyStored) return {};
    console.warn(
      JSON.stringify({ msg: "subtree_card_count_unknown_move", selectorOptionId: row._id }),
    );
    return UNKNOWN_SUBTREE;
  }
  if (!delta || isZero(delta)) return {};
  if (stored === undefined || storedBase === undefined) {
    return anyStored ? UNKNOWN_SUBTREE : {};
  }
  const next = stored + delta.all;
  const nextBase = storedBase + delta.nonVariation;
  if (next < 0 || nextBase < 0 || nextBase > next) {
    console.warn(
      JSON.stringify({
        msg: "subtree_card_count_drift",
        selectorOptionId: row._id,
        stored,
        storedBase,
        delta: delta.all,
        deltaBase: delta.nonVariation,
      }),
    );
    return UNKNOWN_SUBTREE;
  }
  return { subtreeCardCount: next, subtreeNonVariationCardCount: nextBase };
}

export function createCardCountLedger(): CardCountLedger {
  return new CardCountLedger();
}

// ───────────────────────────────────────────────────────────────────────────
// The backfill
// ───────────────────────────────────────────────────────────────────────────

const CONFIRM_TOKEN = "BACKFILL";
const ENV_FLAG = "ALLOW_CARD_COUNT_BACKFILL";

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "1" || value === "true";
}

/** The levels a card can sit on. */
export const CARD_BEARING_LEVELS = ["variantType", "insert", "parallel"] as const;
type CardBearingLevel = (typeof CARD_BEARING_LEVELS)[number];

/** Rows read per page. Each costs one `.take` and at most one patch. */
const ROWS_PER_PAGE = 100;
/**
 * Cards read per page, across its rows. A page stops after the row that
 * crosses this; the next page resumes after that row. Document count, not
 * operations: one `.take` is one operation however many rows it returns.
 */
const CARDS_READ_PER_PAGE = 3_000;

/** A call stops after the first page that lands past this; re-run to resume. */
const TIME_BUDGET_MS = 150_000;

const NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed for the backfill. ` +
  `Set ${ENV_FLAG}=1 on it (npx convex env set ${ENV_FLAG} 1), re-run, and ` +
  `remove the flag afterwards. Nothing was written; the counts below are what ` +
  `an armed run would have done.`;
const APPLIED_MESSAGE = "Applied. Re-run to confirm the steady state.";
const DRY_RUN_MESSAGE =
  `Dry run — nothing written. Arm with ${ENV_FLAG}=1 on the deployment and ` +
  `re-run with {"confirm":"${CONFIRM_TOKEN}"} to apply.`;

const pageResultValidator = v.object({
  scanned: v.number(),
  filled: v.number(),
  repaired: v.number(),
  disagreed: v.number(),
  cardsRead: v.number(),
  /**
   * Set when the page stopped on the card budget before its last row: call
   * again with the SAME cursor and `skip` = this, and the rows already done
   * are passed over. Absent when the whole page was walked.
   */
  resumeSkip: v.optional(v.number()),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

/**
 * One page of one level. `apply: false` computes the same answer and writes
 * nothing. A row over `RECOUNT_MAX` throws rather than writing a count it
 * could not read.
 *
 * `filled`: a row missing either count, both written. `disagreed`: stored
 * counts that do not match the recount; written (`repaired`) only with
 * `repair: true`.
 */
export const backfillVariantCardCountsPage = internalMutation({
  args: {
    level: v.union(
      v.literal("variantType"),
      v.literal("insert"),
      v.literal("parallel"),
    ),
    cursor: v.union(v.string(), v.null()),
    /** Rows at the head of this page already handled by an earlier call. */
    skip: v.optional(v.number()),
    apply: v.boolean(),
    repair: v.boolean(),
    numItems: v.optional(v.number()),
  },
  returns: pageResultValidator,
  handler: async (ctx, args) => {
    if (args.apply && !deploymentIsArmed()) {
      throw new ConvexError(NOT_ARMED_MESSAGE);
    }
    const numItems = Math.max(1, Math.min(args.numItems ?? ROWS_PER_PAGE, ROWS_PER_PAGE));
    const page = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", args.level))
      .paginate({ cursor: args.cursor, numItems });

    let filled = 0;
    let repaired = 0;
    let disagreed = 0;
    let cardsRead = 0;
    let scanned = 0;
    let resumeSkip: number | undefined;
    const skip = Math.max(0, Math.floor(args.skip ?? 0));
    for (let i = skip; i < page.page.length; i++) {
      // The card budget is checked BETWEEN rows, and the first row is always
      // attempted, so a page always advances.
      if (i > skip && cardsRead >= CARDS_READ_PER_PAGE) {
        resumeSkip = i;
        break;
      }
      const row = page.page[i];
      scanned++;
      const counted = await recountCards(ctx, row._id);
      if (counted === null) {
        throw new ConvexError(
          `Refused: ${args.level} row ${row._id} has more than ${RECOUNT_MAX} ` +
            `cards; count it by hand. Nothing on this page was written.`,
        );
      }
      cardsRead += counted.cardCount;
      // Both counts are written together, always: a row never carries one
      // without the other.
      const absent =
        row.cardCount === undefined || row.nonVariationCardCount === undefined;
      const differs =
        row.cardCount !== counted.cardCount ||
        row.nonVariationCardCount !== counted.nonVariationCardCount;
      if (absent) {
        filled++;
        if (args.apply) await ctx.db.patch(row._id, counted);
      } else if (differs) {
        disagreed++;
        if (args.repair) {
          repaired++;
          if (args.apply) await ctx.db.patch(row._id, counted);
        }
      }
    }
    return {
      scanned,
      filled,
      repaired,
      disagreed,
      cardsRead,
      ...(resumeSkip !== undefined ? { resumeSkip } : {}),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** Parse the action's resume cursor; see `backfillVariantCardCounts`. */
export function parseResumeCursor(raw: string): {
  levelIndex: number;
  skip: number;
  cursor: string | null;
} {
  const first = raw.indexOf(":");
  const second = first === -1 ? -1 : raw.indexOf(":", first + 1);
  const level = first === -1 ? raw : raw.slice(0, first);
  const levelIndex = CARD_BEARING_LEVELS.indexOf(level as CardBearingLevel);
  const skipText = first === -1 ? "0" : raw.slice(first + 1, second === -1 ? undefined : second);
  const skip = Number(skipText);
  if (levelIndex === -1 || !Number.isInteger(skip) || skip < 0) {
    throw new ConvexError(`Refused: cursor ${raw} is not one this backfill returned.`);
  }
  const rest = second === -1 ? "" : raw.slice(second + 1);
  return { levelIndex, skip, cursor: rest.length > 0 ? rest : null };
}

/**
 * NEO-358 — fill `selectorOptions.cardCount` and `nonVariationCardCount` for
 * every card-bearing row.
 * Dry run by default; see the header for the operator commands.
 *
 * Walks `variantType`, then `insert`, then `parallel`, paging each. The
 * returned `cursor` is `<level>:<skip>:<page cursor>` and resumes exactly
 * there.
 * Idempotent: a row whose count already matches costs one read.
 */
export const backfillVariantCardCounts = internalAction({
  args: {
    confirm: v.optional(v.string()),
    cursor: v.optional(v.string()),
    repair: v.optional(v.literal(true)),
    /** Lowers the rows per page; for tests. */
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    armed: v.boolean(),
    message: v.string(),
    complete: v.boolean(),
    cursor: v.optional(v.string()),
    scanned: v.number(),
    filled: v.number(),
    repaired: v.number(),
    disagreed: v.number(),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;
    const repair = args.repair === true;
    const startedAt = Date.now();

    let levelIndex = 0;
    let cursor: string | null = null;
    let skip = 0;
    if (args.cursor) {
      const parsed = parseResumeCursor(args.cursor);
      levelIndex = parsed.levelIndex;
      skip = parsed.skip;
      cursor = parsed.cursor;
    }

    const totals = { scanned: 0, filled: 0, repaired: 0, disagreed: 0 };
    let complete = false;
    for (;;) {
      if (levelIndex >= CARD_BEARING_LEVELS.length) {
        complete = true;
        break;
      }
      const level = CARD_BEARING_LEVELS[levelIndex];
      const page: {
        scanned: number;
        filled: number;
        repaired: number;
        disagreed: number;
        cardsRead: number;
        resumeSkip?: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runMutation(internal.cardCounts.backfillVariantCardCountsPage, {
        level,
        cursor,
        ...(skip > 0 ? { skip } : {}),
        apply: armed,
        repair,
        ...(args.numItems !== undefined ? { numItems: args.numItems } : {}),
      });
      totals.scanned += page.scanned;
      totals.filled += page.filled;
      totals.repaired += page.repaired;
      totals.disagreed += page.disagreed;
      if (page.resumeSkip !== undefined) {
        // Same page again, past the rows it already did.
        skip = page.resumeSkip;
      } else if (page.isDone) {
        levelIndex += 1;
        cursor = null;
        skip = 0;
      } else {
        cursor = page.continueCursor;
        skip = 0;
      }
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
    }

    // One audit line: counts and flags only.
    console.log(
      JSON.stringify({
        msg: "backfill_variant_card_counts",
        armed,
        refusedForFlag,
        repair,
        complete,
        ...totals,
      }),
    );

    // `<level>:<skip>:<page cursor>` — the page cursor goes last because it
    // is opaque and may itself contain a colon.
    const resumeAt =
      complete || levelIndex >= CARD_BEARING_LEVELS.length
        ? undefined
        : `${CARD_BEARING_LEVELS[levelIndex]}:${skip}:${cursor ?? ""}`;
    return {
      armed,
      message: refusedForFlag ? NOT_ARMED_MESSAGE : armed ? APPLIED_MESSAGE : DRY_RUN_MESSAGE,
      complete,
      ...(resumeAt !== undefined ? { cursor: resumeAt } : {}),
      ...totals,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// The subtree backfill
// ───────────────────────────────────────────────────────────────────────────

const SUBTREE_ENV_FLAG = "ALLOW_SUBTREE_CARD_COUNT_BACKFILL";

function subtreeDeploymentIsArmed(): boolean {
  const value = process.env[SUBTREE_ENV_FLAG];
  return value === "1" || value === "true";
}

/**
 * Every level, DEEPEST FIRST: a row's subtree count is its own count plus its
 * children's subtree counts, so each level is walked only after every level
 * beneath it has been filled.
 */
export const SUBTREE_LEVELS = [
  "parallel",
  "insert",
  "variantType",
  "setName",
  "manufacturer",
  "year",
  "sport",
] as const;
type SubtreeLevel = (typeof SUBTREE_LEVELS)[number];

/**
 * The most children one row may have for the backfill to sum it. Above the
 * largest real bucket (a year's Unknown brand, `MAX_YEAR_SET_ROWS`).
 */
export const SUBTREE_MAX_CHILDREN = 5_000;

/**
 * NEO-364 — whether `child` may hold cards, for its sport, year or
 * manufacturer parent: a flag-level child by its `hasCards`; any other by its
 * subtree count, where UNKNOWN counts as maybe (shown, never hidden), and its
 * own count, so a drifted subtree zero never hides a row holding cards.
 */
function childMayHoldCards(child: Row): boolean {
  if (carriesHasCards(child.level)) return child.hasCards === true;
  if (typeof child.cardCount === "number" && child.cardCount > 0) return true;
  if (
    child.subtreeCardCount === undefined ||
    child.subtreeNonVariationCardCount === undefined
  ) {
    return true;
  }
  return child.subtreeCardCount > 0;
}

const SUBTREE_NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed for the backfill. ` +
  `Set ${SUBTREE_ENV_FLAG}=1 on it (npx convex env set ${SUBTREE_ENV_FLAG} 1), ` +
  `re-run, and remove the flag afterwards. Nothing was written; the counts ` +
  `below are what an armed run would have done.`;
const SUBTREE_DRY_RUN_MESSAGE =
  `Dry run — nothing written. Arm with ${SUBTREE_ENV_FLAG}=1 on the deployment ` +
  `and re-run with {"confirm":"${CONFIRM_TOKEN}"} to apply. A dry run cannot ` +
  `fill a level for the level above it to read, so rows above the deepest ` +
  `unfilled level report as "waiting", and the year and sport flags are ` +
  `judged on the brand and year flags as they stand now.`;

const subtreeLevelValidator = v.union(
  v.literal("parallel"),
  v.literal("insert"),
  v.literal("variantType"),
  v.literal("setName"),
  v.literal("manufacturer"),
  v.literal("year"),
  v.literal("sport"),
);

const subtreePageResultValidator = v.object({
  scanned: v.number(),
  filled: v.number(),
  repaired: v.number(),
  disagreed: v.number(),
  /** Rows left alone because a child's subtree count is still unknown. */
  waiting: v.number(),
  /** NEO-364 — sport, year and manufacturer rows given `hasCards`. */
  flagsSet: v.number(),
  /** NEO-364 — sport, year and manufacturer rows whose `hasCards` was unset (nothing below). */
  flagsCleared: v.number(),
  /** NEO-364 — sport, year and manufacturer rows whose old subtree counts were cleared. */
  staleCountsCleared: v.number(),
  docsRead: v.number(),
  /** As in `backfillVariantCardCountsPage`: same cursor, skip this many. */
  resumeSkip: v.optional(v.number()),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

/**
 * One page of one level. `apply: false` computes the same answer and writes
 * nothing.
 *
 * A row's subtree = its own counts (stored; recounted read-only when absent,
 * so a row the own-count backfill has not reached yet still sums right) plus
 * every child's STORED subtree counts. A child whose subtree count is unknown
 * leaves the row as it stands (`waiting`); the next run picks it up. A row
 * with more than `SUBTREE_MAX_CHILDREN` children, or more than `RECOUNT_MAX`
 * own cards, throws rather than writing a count it could not read.
 *
 * `filled`: a row missing either subtree count, both written. `disagreed`:
 * stored subtree counts that do not match the sum; written (`repaired`) only
 * with `repair: true`.
 *
 * NEO-364 — a sport, year or manufacturer row keeps no subtree counts: it
 * gets `hasCards: true` when any child below may hold cards (a set with
 * cards or of unknown count; a brand or year that carries the flag), and has
 * the flag unset when none does (`flagsSet`, `flagsCleared`; always, not
 * only with `repair`). Any NEO-358 subtree counts still on it are cleared
 * (`staleCountsCleared`). Levels are walked deepest first, so a brand is
 * judged before its year and a year before its sport.
 */
export const backfillSubtreeCardCountsPage = internalMutation({
  args: {
    level: subtreeLevelValidator,
    cursor: v.union(v.string(), v.null()),
    skip: v.optional(v.number()),
    apply: v.boolean(),
    repair: v.boolean(),
    numItems: v.optional(v.number()),
  },
  returns: subtreePageResultValidator,
  handler: async (ctx, args) => {
    if (args.apply && !subtreeDeploymentIsArmed()) {
      throw new ConvexError(SUBTREE_NOT_ARMED_MESSAGE);
    }
    const numItems = Math.max(1, Math.min(args.numItems ?? ROWS_PER_PAGE, ROWS_PER_PAGE));
    const page = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", args.level))
      .paginate({ cursor: args.cursor, numItems });

    let scanned = 0;
    let filled = 0;
    let repaired = 0;
    let disagreed = 0;
    let waiting = 0;
    let flagsSet = 0;
    let flagsCleared = 0;
    let staleCountsCleared = 0;
    let docsRead = 0;
    let resumeSkip: number | undefined;
    const skip = Math.max(0, Math.floor(args.skip ?? 0));
    for (let i = skip; i < page.page.length; i++) {
      // Checked BETWEEN rows, and the first row is always attempted, so a
      // page always advances.
      if (i > skip && docsRead >= CARDS_READ_PER_PAGE) {
        resumeSkip = i;
        break;
      }
      const row = page.page[i];
      scanned++;

      let own: CardCounts;
      if (row.cardCount !== undefined && row.nonVariationCardCount !== undefined) {
        own = { cardCount: row.cardCount, nonVariationCardCount: row.nonVariationCardCount };
      } else {
        const counted = await recountCards(ctx, row._id);
        if (counted === null) {
          throw new ConvexError(
            `Refused: ${args.level} row ${row._id} has more than ${RECOUNT_MAX} ` +
              `cards of its own; count it by hand. Nothing on this page was written.`,
          );
        }
        docsRead += counted.cardCount;
        own = counted;
      }

      const children = await ctx.db
        .query("selectorOptions")
        .withIndex("by_parent", (q) => q.eq("parentId", row._id))
        .take(SUBTREE_MAX_CHILDREN + 1);
      if (children.length > SUBTREE_MAX_CHILDREN) {
        throw new ConvexError(
          `Refused: ${args.level} row ${row._id} has more than ` +
            `${SUBTREE_MAX_CHILDREN} rows beneath it; sum it by hand. Nothing ` +
            `on this page was written.`,
        );
      }
      docsRead += children.length;

      if (carriesHasCards(row.level)) {
        // NEO-364 — sport, year, manufacturer: `hasCards` when any card sits
        // on the row or any child below holds cards or is of unknown size
        // (shown, never hidden, when in doubt); unset otherwise. The
        // NEO-358 subtree counts these levels no longer keep are cleared.
        const holds =
          own.cardCount > 0 || children.some((child) => childMayHoldCards(child));
        const patch: Partial<Row> = {};
        if (holds && row.hasCards !== true) {
          flagsSet++;
          patch.hasCards = true;
        } else if (!holds && row.hasCards !== undefined) {
          flagsCleared++;
          patch.hasCards = undefined;
        }
        if (
          row.subtreeCardCount !== undefined ||
          row.subtreeNonVariationCardCount !== undefined
        ) {
          staleCountsCleared++;
          Object.assign(patch, UNKNOWN_SUBTREE);
        }
        if (args.apply && Object.keys(patch).length > 0) await ctx.db.patch(row._id, patch);
        continue;
      }

      let all = own.cardCount;
      let base = own.nonVariationCardCount;
      let childUnknown = false;
      for (const child of children) {
        if (
          child.subtreeCardCount === undefined ||
          child.subtreeNonVariationCardCount === undefined
        ) {
          childUnknown = true;
          break;
        }
        all += child.subtreeCardCount;
        base += child.subtreeNonVariationCardCount;
      }
      if (childUnknown) {
        waiting++;
        continue;
      }
      const computed: SubtreeCounts = {
        subtreeCardCount: all,
        subtreeNonVariationCardCount: base,
      };
      const absent =
        row.subtreeCardCount === undefined || row.subtreeNonVariationCardCount === undefined;
      const differs =
        row.subtreeCardCount !== all || row.subtreeNonVariationCardCount !== base;
      if (absent) {
        filled++;
        if (args.apply) await ctx.db.patch(row._id, computed);
      } else if (differs) {
        disagreed++;
        if (args.repair) {
          repaired++;
          if (args.apply) await ctx.db.patch(row._id, computed);
        }
      }
    }
    return {
      scanned,
      filled,
      repaired,
      disagreed,
      waiting,
      flagsSet,
      flagsCleared,
      staleCountsCleared,
      docsRead,
      ...(resumeSkip !== undefined ? { resumeSkip } : {}),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** Parse the subtree backfill's resume cursor; see `backfillSubtreeCardCounts`. */
export function parseSubtreeResumeCursor(raw: string): {
  levelIndex: number;
  skip: number;
  cursor: string | null;
} {
  const first = raw.indexOf(":");
  const second = first === -1 ? -1 : raw.indexOf(":", first + 1);
  const level = first === -1 ? raw : raw.slice(0, first);
  const levelIndex = SUBTREE_LEVELS.indexOf(level as SubtreeLevel);
  const skipText = first === -1 ? "0" : raw.slice(first + 1, second === -1 ? undefined : second);
  const skip = Number(skipText);
  if (levelIndex === -1 || !Number.isInteger(skip) || skip < 0) {
    throw new ConvexError(`Refused: cursor ${raw} is not one this backfill returned.`);
  }
  const rest = second === -1 ? "" : raw.slice(second + 1);
  return { levelIndex, skip, cursor: rest.length > 0 ? rest : null };
}

/**
 * NEO-358 — fill `selectorOptions.subtreeCardCount` and
 * `subtreeNonVariationCardCount` on every row from the set down, bottom-up,
 * and (NEO-364) set or unset `hasCards` on every sport, year and manufacturer
 * row, clearing the subtree counts those levels no longer keep. Run it AFTER
 * `backfillVariantCardCounts` reports complete. Dry run by default; see the
 * header for the operator commands.
 *
 * Walks `parallel`, `insert`, `variantType`, `setName`, `manufacturer`,
 * `year`, then `sport`, paging each. The returned `cursor` is
 * `<level>:<skip>:<page cursor>` and resumes exactly there. `waiting` counts
 * rows left for a later run because a child was still unknown (on an armed
 * run, a row created mid-run without counts); re-run until `complete` is
 * true and `waiting` is 0.
 * Idempotent: a row whose counts already match costs its reads only.
 */
export const backfillSubtreeCardCounts = internalAction({
  args: {
    confirm: v.optional(v.string()),
    cursor: v.optional(v.string()),
    repair: v.optional(v.literal(true)),
    /** Lowers the rows per page; for tests. */
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    armed: v.boolean(),
    message: v.string(),
    complete: v.boolean(),
    cursor: v.optional(v.string()),
    scanned: v.number(),
    filled: v.number(),
    repaired: v.number(),
    disagreed: v.number(),
    waiting: v.number(),
    flagsSet: v.number(),
    flagsCleared: v.number(),
    staleCountsCleared: v.number(),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !subtreeDeploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;
    const repair = args.repair === true;
    const startedAt = Date.now();

    let levelIndex = 0;
    let cursor: string | null = null;
    let skip = 0;
    if (args.cursor) {
      const parsed = parseSubtreeResumeCursor(args.cursor);
      levelIndex = parsed.levelIndex;
      skip = parsed.skip;
      cursor = parsed.cursor;
    }

    const totals = {
      scanned: 0,
      filled: 0,
      repaired: 0,
      disagreed: 0,
      waiting: 0,
      flagsSet: 0,
      flagsCleared: 0,
      staleCountsCleared: 0,
    };
    let complete = false;
    for (;;) {
      if (levelIndex >= SUBTREE_LEVELS.length) {
        complete = true;
        break;
      }
      const level = SUBTREE_LEVELS[levelIndex];
      const page: {
        scanned: number;
        filled: number;
        repaired: number;
        disagreed: number;
        waiting: number;
        flagsSet: number;
        flagsCleared: number;
        staleCountsCleared: number;
        docsRead: number;
        resumeSkip?: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runMutation(internal.cardCounts.backfillSubtreeCardCountsPage, {
        level,
        cursor,
        ...(skip > 0 ? { skip } : {}),
        apply: armed,
        repair,
        ...(args.numItems !== undefined ? { numItems: args.numItems } : {}),
      });
      totals.scanned += page.scanned;
      totals.filled += page.filled;
      totals.repaired += page.repaired;
      totals.disagreed += page.disagreed;
      totals.waiting += page.waiting;
      totals.flagsSet += page.flagsSet;
      totals.flagsCleared += page.flagsCleared;
      totals.staleCountsCleared += page.staleCountsCleared;
      if (page.resumeSkip !== undefined) {
        skip = page.resumeSkip;
      } else if (page.isDone) {
        levelIndex += 1;
        cursor = null;
        skip = 0;
      } else {
        cursor = page.continueCursor;
        skip = 0;
      }
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
    }

    // One audit line: counts and flags only.
    console.log(
      JSON.stringify({
        msg: "backfill_subtree_card_counts",
        armed,
        refusedForFlag,
        repair,
        complete,
        ...totals,
      }),
    );

    const resumeAt =
      complete || levelIndex >= SUBTREE_LEVELS.length
        ? undefined
        : `${SUBTREE_LEVELS[levelIndex]}:${skip}:${cursor ?? ""}`;
    return {
      armed,
      message: refusedForFlag
        ? SUBTREE_NOT_ARMED_MESSAGE
        : armed
          ? APPLIED_MESSAGE
          : SUBTREE_DRY_RUN_MESSAGE,
      complete,
      ...(resumeAt !== undefined ? { cursor: resumeAt } : {}),
      ...totals,
    };
  },
});
