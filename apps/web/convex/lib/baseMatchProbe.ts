/**
 * NEO-325 — the wire contract and the pure helpers of the Base match probe
 * (`convex/baseMatchProbe.ts`), shared with the `"use node"` adapters that do
 * the fetching (`adapters/sportlots.ts`, `adapters/buysportscards.ts`).
 *
 * ## Why this is a separate file
 *
 * The probe's public actions run in the default runtime and cannot import a
 * `"use node"` module; the adapters cannot be reached except through
 * `ctx.runAction`. The bounds, validators and the "first card" rule live here
 * so both sides read one definition (the house pattern: contract narrowers
 * live in `convex/lib`).
 *
 * **Pure by contract.** No `_generated/server`, no `process.env`, no I/O.
 *
 * ## What "first card" means
 *
 * The first row, in the marketplace's own order, that is NOT a variation, by
 * `fetchedIsVariation` — the reading the parallel build's link uses, so the
 * probe and the build agree about which rows are variations. Both adapters
 * already order a checklist by card number (SportLots' listing order; BSC's
 * `sort: "default"`), variations interleaved after the card they vary.
 */

import { ConvexError, v, type Infer } from "convex/values";
import { fetchFailureKindValidator } from "./marketplaceFetchFailure";
import { fetchedIsVariation } from "./parallelCardLink";
import { MAX_SL_ID_LENGTH } from "../selectorSyncMatch";
import { MAX_SLOT_LABEL_LENGTH } from "../platformSlots";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** SportLots set ids one `probeSlFirstPage` call reads (one page each). */
export const MAX_SL_FIRST_PAGE_IDS = 32;
/** SportLots set ids one `probeSlCount` call walks in full. */
export const MAX_SL_COUNT_IDS = 8;
/** BSC variantName ids one `probeBscSets` call fetches. */
export const MAX_BSC_PROBE_IDS = 4;
/** SportLots sets read at once inside one call. */
export const SL_PROBE_CONCURRENCY = 8;
/** A SportLots set id is a short slug (`MAX_SL_ID_LENGTH`). */
export const MAX_SL_PROBE_ID_LENGTH = MAX_SL_ID_LENGTH;
/**
 * A BSC id is a facet slug derived from a set name, so it gets the name's
 * ceiling — the same bound the twin notice keeps (`MAX_TWIN_NOTICE_ID_LENGTH`).
 */
export const MAX_BSC_PROBE_ID_LENGTH = MAX_SLOT_LABEL_LENGTH;
/** The longest marketplace string a probe result carries back. */
export const PROBE_TEXT_MAX = 200;
/** Players named on a probe's first card. */
export const PROBE_MAX_PLAYERS = 8;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/** The first non-variation card of a marketplace set, as fetched. */
export const probeFirstCardValidator = v.object({
  cardNumber: v.string(),
  cardName: v.string(),
  players: v.optional(v.array(v.string())),
  /** Never set: `first` is always a non-variation row. Kept for the contract. */
  isVariation: v.optional(v.boolean()),
});
export type ProbeFirstCard = Infer<typeof probeFirstCardValidator>;

const failedValidator = v.object({
  id: v.string(),
  status: v.literal("failed"),
  kind: fetchFailureKindValidator,
});

/**
 * What the SportLots adapter answers per set id, for either probe: the walk's
 * summary, never its rows. The public actions shape it.
 */
export const slListcardsSummaryValidator = v.union(
  v.object({
    id: v.string(),
    status: v.literal("ok"),
    first: v.optional(probeFirstCardValidator),
    /** Parsed card rows, variations included. */
    rows: v.number(),
    nonVariationRows: v.number(),
    /** Pages read successfully (the empty end-of-set page included). */
    pages: v.number(),
  }),
  failedValidator,
);
export type SlListcardsSummary = Infer<typeof slListcardsSummaryValidator>;

/** `probeSlFirstPage`, per id. */
export const slFirstPageResultValidator = v.union(
  v.object({
    id: v.string(),
    status: v.literal("ok"),
    first: v.optional(probeFirstCardValidator),
    nonVariationRowsOnPage: v.number(),
    pageHadRows: v.boolean(),
  }),
  failedValidator,
);
export type SlFirstPageResult = Infer<typeof slFirstPageResultValidator>;

/** `probeSlCount`, per id. */
export const slCountResultValidator = v.union(
  v.object({
    id: v.string(),
    status: v.literal("ok"),
    /** Non-variation rows across the whole set. */
    count: v.number(),
    pages: v.number(),
  }),
  failedValidator,
);
export type SlCountResult = Infer<typeof slCountResultValidator>;

/** One BSC request the batch adapter sends: the probe id and its filters. */
export const bscProbeRequestValidator = v.object({
  id: v.string(),
  facetFilters: v.record(v.string(), v.array(v.string())),
});

/** What the BSC adapter answers per probe id. */
export const bscProbeSummaryValidator = v.union(
  v.object({
    id: v.string(),
    status: v.literal("ok"),
    /** Non-variation cards in the set. */
    count: v.number(),
    first: v.optional(probeFirstCardValidator),
  }),
  failedValidator,
);
export type BscProbeSummary = Infer<typeof bscProbeSummaryValidator>;

/** `probeBscSets`, per id. `refused`: the chain cannot scope the request. */
export const bscProbeResultValidator = v.union(
  v.object({
    id: v.string(),
    status: v.literal("ok"),
    count: v.number(),
    first: v.optional(probeFirstCardValidator),
  }),
  v.object({
    id: v.string(),
    status: v.union(v.literal("failed"), v.literal("refused")),
    kind: v.optional(fetchFailureKindValidator),
  }),
);
export type BscProbeResult = Infer<typeof bscProbeResultValidator>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * The ids of one probe call, checked and de-duplicated (first-seen order).
 * Throws a `ConvexError` naming the bound, never the id, when the call asks
 * for more than `max` distinct ids or any id is empty, too long or carries a
 * control character: a refusal before anything is fetched.
 */
export function checkProbeIds(
  ids: readonly string[],
  bounds: { max: number; maxLength: number },
): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (id.length === 0 || id.length > bounds.maxLength || CONTROL_CHARS.test(id)) {
      throw new ConvexError(
        `A marketplace set id is empty, longer than ${bounds.maxLength} characters or not plain text.`,
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  if (unique.length > bounds.max) {
    throw new ConvexError(`At most ${bounds.max} marketplace sets per call.`);
  }
  return unique;
}

/** A fetched card as either adapter returns it, reduced to what a probe reads. */
export type ProbeCardLike = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  isVariation?: boolean;
  cardVariation?: string;
};

function bounded(text: string): string {
  return text.length > PROBE_TEXT_MAX ? text.slice(0, PROBE_TEXT_MAX) : text;
}

/**
 * The first non-variation card (marketplace order), the row count and the
 * non-variation count of a fetched list. `first` is absent when every row is
 * a variation or there are none.
 */
export function summarizeProbeCards(cards: readonly ProbeCardLike[]): {
  first?: ProbeFirstCard;
  rows: number;
  nonVariationRows: number;
} {
  let first: ProbeFirstCard | undefined;
  let nonVariationRows = 0;
  for (const card of cards) {
    if (fetchedIsVariation(card)) continue;
    nonVariationRows++;
    if (!first) {
      const players = (card.players ?? [])
        .slice(0, PROBE_MAX_PLAYERS)
        .map(bounded);
      first = {
        cardNumber: bounded(card.cardNumber),
        cardName: bounded(card.cardName),
        ...(players.length > 0 ? { players } : {}),
      };
    }
  }
  return { ...(first ? { first } : {}), rows: cards.length, nonVariationRows };
}

/** Run `fn` over `items` with at most `limit` in flight; results in order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(0, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
