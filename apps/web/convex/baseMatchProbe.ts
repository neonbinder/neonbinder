/**
 * NEO-325 — the Base match probe: the server half of the PARALLEL Reconcile
 * dialog's check that an unmatched marketplace set really is a parallel of
 * NB's saved Base (Jason, 2026-10-09).
 *
 * The client compares each unmatched marketplace set's card count and first
 * card (number + player) with the Base's, and puts a set that disagrees behind
 * a toggle. Everything here only READS the catalog: the NB Base's signature,
 * and a summary of each marketplace set fetched by its own id. No catalog row
 * (selector option, card, player, team) is written, and the comparison itself
 * is the client's. The marketplace token path is the one exception, the same
 * one every checklist fetch has: reading a token may refresh it, and a 401
 * re-auth goes through `credentials.refreshSiteTokenAfterRejection`, so the
 * user's credential status (`userProfiles.siteCredentials`: the credential
 * lock, `needsReauth`) can be updated along the way.
 *
 * ## The invariant, here
 *
 *   - Nothing takes an NB display name. The Base is found by the NB flag
 *     (`metadata.isBase`, `pickBaseVariantType`), the parallel type by its NB
 *     role (`variantTypeRole`), and every marketplace request is built from
 *     ids: the SportLots set ids the client holds, the BSC `variantName` ids
 *     it holds plus the chain's own slot ids (`resolveBscFacetFilters`).
 *   - A BSC request the chain cannot scope (`missingBscChecklistScope`) is
 *     refused per id, never widened.
 *   - A paused marketplace is not contacted (NEO-287 backstop).
 *
 * ## Cost (per call)
 *
 *   - `getBaseSignatureForVariantType`: one get, ≤201 sibling reads, ≤6 chain
 *     gets and ONE byte-bounded page of the Base's cards (≤5,001 rows,
 *     `SIGNATURE_CARD_READ_BYTES`). A reactive subscription over the Base's
 *     cards.
 *   - `probeSlFirstPage`: one token read + one SportLots page per id, 8 at a
 *     time.
 *   - `probeSlCount`: one token read + a full walk per id (a 300-card set is
 *     5 pages), 8 at a time, at most `SL_PROBE_COUNT_MAX_PAGES` pages per id
 *     and `SL_PROBE_DEADLINE_MS` for the whole call.
 *   - `probeBscSets`: one chain query, one token read, then per id one BSC
 *     request per fan-out combination (usually one), sequentially, inside
 *     `BSC_PROBE_DEADLINE_MS` for the whole batch. At most
 *     one re-auth for the whole batch, through the NEO-278 backoff and the
 *     credential lock.
 */

import { v } from "convex/values";
import { action, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireAdmin } from "./auth";
import { variantTypeRole } from "./variantRole";
import {
  MAX_INSERT_CARDS_FOR_BUILD,
  MAX_VARIANT_TYPES_PER_SET,
  linkableOf,
  pickBaseVariantType,
} from "./parallelChecklistBuild";
import { missingBscChecklistScope, resolveBscFacetFilters } from "./bscFacets";
import { isPlatformPaused } from "./marketplacePause";
import {
  MAX_BSC_PROBE_IDS,
  MAX_BSC_PROBE_ID_LENGTH,
  MAX_SL_COUNT_IDS,
  MAX_SL_FIRST_PAGE_IDS,
  MAX_SL_PROBE_ID_LENGTH,
  SL_PROBE_ID_PATTERN,
  bscProbeResultValidator,
  checkProbeIds,
  slCountResultValidator,
  slFirstPageResultValidator,
  type BscProbeResult,
  type BscProbeSummary,
  type SlCountResult,
  type SlFirstPageResult,
  type SlListcardsSummary,
} from "./lib/baseMatchProbe";

// ---------------------------------------------------------------------------
// The NB Base's signature
// ---------------------------------------------------------------------------

/**
 * Bytes the signature's one card page may read. A query can `paginate` once,
 * so the Base's cards are one page bounded by rows AND bytes; past either the
 * answer is `tooManyCards`, as the build itself refuses past its caps. Leaves
 * 4 MiB of the 16 MiB transaction budget for the sibling and chain reads.
 */
export const SIGNATURE_CARD_READ_BYTES = 12 * 1024 * 1024;

const signatureCardValidator = v.object({
  cardNumber: v.string(),
  cardName: v.string(),
  namesOnCard: v.array(v.string()),
  isTeamCard: v.boolean(),
});
type SignatureCard = {
  cardNumber: string;
  cardName: string;
  namesOnCard: string[];
  isTeamCard: boolean;
};

export const baseSignatureValidator = v.union(
  v.object({
    status: v.literal("ok"),
    baseId: v.id("selectorOptions"),
    baseName: v.string(),
    /** The non-variation Base card with the lowest `sortOrder`. */
    first: signatureCardValidator,
    /** Non-variation Base cards holding a ref on each side. */
    perSide: v.object({ bsc: v.number(), sportlots: v.number() }),
    /** The prefix stripped from every card number below, when one is set. */
    cardNumberPrefix: v.optional(v.string()),
    /** Every non-variation Base card, in `sortOrder`. At most 5,000. */
    cards: v.array(signatureCardValidator),
  }),
  v.object({
    status: v.union(
      v.literal("notParallelType"),
      v.literal("noBase"),
      v.literal("manyBases"),
      v.literal("noCards"),
      v.literal("tooManyCards"),
    ),
  }),
);

type BaseSignature =
  | {
      status: "ok";
      baseId: Id<"selectorOptions">;
      baseName: string;
      first: SignatureCard;
      perSide: { bsc: number; sportlots: number };
      cardNumberPrefix?: string;
      cards: SignatureCard[];
    }
  | {
      status: "notParallelType" | "noBase" | "manyBases" | "noCards" | "tooManyCards";
    };

/**
 * A card number with the NB chain's `cardNumberPrefix` taken off the front:
 * the predicate `parallelCardLink`'s `stripPrefix` uses (trimmed,
 * case-insensitive, never down to nothing), but the case of what remains is
 * kept, since the client also shows it.
 */
export function stripNbCardNumberPrefix(
  cardNumber: string,
  prefix: string | undefined,
): string {
  const n = cardNumber.trim();
  const p = prefix?.trim();
  if (!p) return n;
  return n.toUpperCase().startsWith(p.toUpperCase()) && n.length > p.length
    ? n.slice(p.length)
    : n;
}

/** The deepest `metadata.cardNumberPrefix` on `row`'s chain, root to row. */
async function deepestCardNumberPrefix(
  ctx: { db: QueryCtx["db"] },
  row: Doc<"selectorOptions">,
): Promise<string | undefined> {
  const chain: Array<Doc<"selectorOptions">> = [row];
  let parentId = row.parentId;
  // A chain is sport → year → manufacturer → setName → variantType; the
  // bound only stops a corrupt parent loop.
  for (let i = 0; parentId && i < 10; i++) {
    const parent: Doc<"selectorOptions"> | null = await ctx.db.get(parentId);
    if (!parent) break;
    chain.unshift(parent);
    parentId = parent.parentId;
  }
  let prefix: string | undefined;
  for (const r of chain) {
    const p = r.metadata?.cardNumberPrefix;
    if (p) prefix = p;
  }
  return prefix;
}

/**
 * The NB Base a PARALLEL variant type is built from, reduced to what the
 * Reconcile dialog compares a marketplace set against. Reads only.
 *
 * `variantTypeId` must be a variantType whose NB role is `"parallel"`
 * (`notParallelType` otherwise). Its Base is the exactly-one sibling flagged
 * `isBase` (`noBase`, `manyBases`); a set with more variant types than the
 * lookup reads is `manyBases` too, because an unread row could be a second
 * Base. Cards over 5,000, or over `SIGNATURE_CARD_READ_BYTES`, are
 * `tooManyCards`; a Base with no non-variation card is `noCards`.
 */
export const getBaseSignatureForVariantType = query({
  args: { variantTypeId: v.id("selectorOptions") },
  returns: baseSignatureValidator,
  handler: async (ctx, args): Promise<BaseSignature> => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(args.variantTypeId);
    if (!row || row.level !== "variantType" || variantTypeRole(row) !== "parallel") {
      return { status: "notParallelType" };
    }
    const setNameId = row.parentId;
    if (!setNameId) return { status: "noBase" };

    const siblings = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "variantType").eq("parentId", setNameId),
      )
      .take(MAX_VARIANT_TYPES_PER_SET + 1);
    if (siblings.length > MAX_VARIANT_TYPES_PER_SET) {
      return { status: "manyBases" };
    }
    const picked = pickBaseVariantType(siblings);
    if ("blockedReason" in picked) {
      return {
        status: siblings.some((s) => s.metadata?.isBase === true)
          ? "manyBases"
          : "noBase",
      };
    }
    const base = picked.base;

    const page = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", base._id))
      .paginate({
        numItems: MAX_INSERT_CARDS_FOR_BUILD + 1,
        cursor: null,
        maximumBytesRead: SIGNATURE_CARD_READ_BYTES,
      });
    if (!page.isDone || page.page.length > MAX_INSERT_CARDS_FOR_BUILD) {
      return { status: "tooManyCards" };
    }

    const prefix = await deepestCardNumberPrefix(ctx, base);
    const perSide = { bsc: 0, sportlots: 0 };
    const kept: Array<{ sortOrder: number; card: SignatureCard }> = [];
    for (const card of page.page) {
      const linkable = linkableOf(card);
      if (linkable.isVariation) continue;
      if (card.platformData?.bsc?.ref) perSide.bsc++;
      if (card.platformData?.sportlots?.ref) perSide.sportlots++;
      kept.push({
        sortOrder: card.sortOrder,
        card: {
          cardNumber: stripNbCardNumberPrefix(linkable.cardNumber, prefix),
          cardName: linkable.cardName,
          namesOnCard: linkable.namesOnCard,
          isTeamCard: linkable.isTeamCard,
        },
      });
    }
    if (kept.length === 0) return { status: "noCards" };
    // Stable: equal `sortOrder`s keep index (creation) order.
    kept.sort((a, b) => a.sortOrder - b.sortOrder);
    const cards = kept.map((k) => k.card);

    return {
      status: "ok",
      baseId: base._id,
      baseName: base.value,
      first: cards[0],
      perSide,
      ...(prefix ? { cardNumberPrefix: prefix } : {}),
      cards,
    };
  },
});

// ---------------------------------------------------------------------------
// SportLots
// ---------------------------------------------------------------------------

/**
 * The first page of each SportLots set: its first non-variation row (SL's
 * listing order), how many non-variation rows the page held, and whether it
 * held any row at all. At most 32 distinct ids per call, each a numeric
 * SportLots set id (refused above); one cookie read for the whole batch.
 * Writes no catalog row; the cookie read may update credential status, as
 * every SportLots fetch's does.
 */
export const probeSlFirstPage = action({
  args: { setIds: v.array(v.string()) },
  returns: v.array(slFirstPageResultValidator),
  handler: async (ctx, args): Promise<SlFirstPageResult[]> => {
    await requireAdmin(ctx);
    const setIds = checkProbeIds(args.setIds, {
      max: MAX_SL_FIRST_PAGE_IDS,
      maxLength: MAX_SL_PROBE_ID_LENGTH,
      pattern: SL_PROBE_ID_PATTERN,
    });
    if (setIds.length === 0) return [];
    if (isPlatformPaused("sportlots")) {
      return setIds.map((id) => ({ id, status: "failed" as const, kind: "refused" as const }));
    }
    const summaries: SlListcardsSummary[] = await ctx.runAction(
      internal.adapters.sportlots.probeSlListcardsBatch,
      { setIds, mode: "firstPage" },
    );
    return summaries.map((s): SlFirstPageResult =>
      s.status === "ok"
        ? {
            id: s.id,
            status: "ok",
            ...(s.first ? { first: s.first } : {}),
            nonVariationRowsOnPage: s.nonVariationRows,
            pageHadRows: s.rows > 0,
          }
        : s,
    );
  },
});

/**
 * Each SportLots set walked in full: its non-variation row count and the
 * pages read. At most 8 distinct ids per call, each a numeric SportLots set
 * id (refused above); one cookie read for the whole batch. A set longer than
 * `SL_PROBE_COUNT_MAX_PAGES`, or not finished inside `SL_PROBE_DEADLINE_MS`,
 * is `failed` / `timeout`, never a count. Writes no catalog row; the cookie
 * read may update credential status, as every SportLots fetch's does.
 */
export const probeSlCount = action({
  args: { setIds: v.array(v.string()) },
  returns: v.array(slCountResultValidator),
  handler: async (ctx, args): Promise<SlCountResult[]> => {
    await requireAdmin(ctx);
    const setIds = checkProbeIds(args.setIds, {
      max: MAX_SL_COUNT_IDS,
      maxLength: MAX_SL_PROBE_ID_LENGTH,
      pattern: SL_PROBE_ID_PATTERN,
    });
    if (setIds.length === 0) return [];
    if (isPlatformPaused("sportlots")) {
      return setIds.map((id) => ({ id, status: "failed" as const, kind: "refused" as const }));
    }
    const summaries: SlListcardsSummary[] = await ctx.runAction(
      internal.adapters.sportlots.probeSlListcardsBatch,
      { setIds, mode: "count" },
    );
    return summaries.map((s): SlCountResult =>
      s.status === "ok"
        ? { id: s.id, status: "ok", count: s.nonVariationRows, pages: s.pages }
        : s,
    );
  },
});

// ---------------------------------------------------------------------------
// BuySportsCards
// ---------------------------------------------------------------------------

/**
 * Each BSC `variantName` id, fetched under the parallel variant type's own
 * chain: the chain's slot ids (`resolveBscFacetFilters`) with `variantName`
 * set to that one id. An id whose request would lack a required facet
 * (`missingBscChecklistScope`) is `refused` without a request. At most 4
 * distinct ids per call (refused above); one token read for the whole batch.
 * `count` is non-variation cards; `first` the first non-variation card in
 * BSC's order. Writes no catalog row; the token read and a 401's single
 * re-auth may update credential status, as every BSC checklist fetch's do.
 */
export const probeBscSets = action({
  args: {
    variantTypeId: v.id("selectorOptions"),
    variantNameIds: v.array(v.string()),
  },
  returns: v.array(bscProbeResultValidator),
  handler: async (ctx, args): Promise<BscProbeResult[]> => {
    await requireAdmin(ctx);
    const ids = checkProbeIds(args.variantNameIds, {
      max: MAX_BSC_PROBE_IDS,
      maxLength: MAX_BSC_PROBE_ID_LENGTH,
    });
    if (ids.length === 0) return [];
    if (isPlatformPaused("buysportscards")) {
      return ids.map((id) => ({ id, status: "failed" as const, kind: "refused" as const }));
    }

    const chain = await ctx.runQuery(api.selectorOptions.getAncestorChain, {
      id: args.variantTypeId,
    });
    const leaf = chain[chain.length - 1];
    if (
      !leaf ||
      leaf._id !== args.variantTypeId ||
      leaf.level !== "variantType" ||
      variantTypeRole(leaf) !== "parallel"
    ) {
      return ids.map((id) => ({ id, status: "refused" as const }));
    }
    const { filters } = resolveBscFacetFilters(chain);

    const results = new Map<string, BscProbeResult>();
    const requests: Array<{ id: string; facetFilters: Record<string, string[]> }> = [];
    for (const id of ids) {
      const facetFilters = { ...filters, variantName: [id] };
      if (missingBscChecklistScope(facetFilters).length > 0) {
        results.set(id, { id, status: "refused" });
        continue;
      }
      requests.push({ id, facetFilters });
    }
    if (requests.length > 0) {
      const summaries: BscProbeSummary[] = await ctx.runAction(
        internal.adapters.buysportscards.probeBscChecklistBatch,
        { requests },
      );
      for (const s of summaries) results.set(s.id, s);
    }
    return ids.map(
      (id): BscProbeResult =>
        results.get(id) ?? { id, status: "failed", kind: "unknown" },
    );
  },
});
