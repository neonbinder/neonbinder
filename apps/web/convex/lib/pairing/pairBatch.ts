/**
 * Front/back card pairing over a known batch of images.
 *
 * This is the public surface of the pairing port (NEO-150 → NEO-170). It
 * answers one question: given every image in an upload, in upload order,
 * which of them are the front and back of the same physical card?
 *
 * **Why a batch function and not a long-lived pool.** The TypeScript original
 * (`script-frontend/src/utils/cardPool.ts`) is a stateful pool living for the
 * duration of a filesystem watch session: images trickle in one at a time and
 * the pool holds the unpaired ones indefinitely. Convex functions are
 * short-lived, so an in-process pool would not survive across invocations. It
 * does not need to — the whole upload is known up front, which makes pairing
 * a pure function over a known list. The pool is kept as an internal
 * implementation detail (`pool.ts`, `CardPool`) because its incremental
 * semantics are load-bearing, and is fed in upload order behind `pairBatch`.
 *
 * This module is a pure library: zero dependencies, no Node APIs, no Convex
 * function of its own. The NEO-170 pipeline imports it.
 *
 * ## The cost model
 *
 * Identity extraction (player / team / card number / side) is a model call
 * per image. It is the dominant marginal cost of a batch and the thing this
 * module is shaped to avoid.
 *
 * What is *not* a cost is `textCount`: the OCR word-annotation count already
 * produced for every image during preprocessing. It is sunk, it is free to
 * re-read, and `textCount >= 5` is the long-standing side heuristic (a card
 * back is dense with stats and copyright text; a front is a photo with a name
 * on it). A pre-computed `side` on a `BatchImage` is likewise sunk — see
 * `imageConfidentSide`.
 *
 * So `pairBatch` runs in two phases:
 *
 * 1. **Adjacency pre-pass** (`planAdjacency`) — scanners emit fronts and
 *    backs in strict alternation, so consecutive images in upload order are
 *    usually the two sides of one card. Where the free side evidence
 *    *confidently* assigns opposite sides to two neighbours, they are paired
 *    immediately and **the identity resolver is never called for either of
 *    them**.
 *
 * 2. **Scoring pool** — everything the pre-pass could not claim (an odd
 *    stray, a re-scan, an out-of-order dump, or any image whose text count is
 *    too close to the threshold to trust) goes through the full ported
 *    matcher, resolving identity lazily, one call per image, at the moment
 *    the pool needs it.
 *
 * `BatchResult.resolverCalls` reports the resulting spend.
 */

import { CardPool } from "./pool";
import {
  BatchImage,
  BatchResult,
  CardIdentity,
  CardSide,
  IdentityResolver,
  ImageHasher,
  MatchResult,
  PoolCard,
  createPoolCard,
  makeMatchResult,
} from "./types";

/**
 * OCR word count at or above which an image is treated as a card back.
 * Ported from the source's `textDetectionCount >= 5 ? 'back' : 'front'`
 * fallback: card backs carry stat tables, career blurbs and copyright lines
 * (typically 20+ word annotations), while a front is a photo with a name and
 * maybe a team (0-3). 5 sits in the empty middle.
 */
export const TEXT_COUNT_BACK_THRESHOLD = 5;

/**
 * How far from `TEXT_COUNT_BACK_THRESHOLD` a text count must sit before the
 * adjacency pre-pass will act on it without paying for a classify.
 *
 * This band has no counterpart in the original TypeScript, which only ever
 * used the heuristic as a last-resort fallback *after* an AI classify had
 * already failed to report a side. Here it is being used as the sole evidence
 * for consuming two images without any AI call at all, so it needs a margin:
 * a text-light back (a checklist back, a back that cropped badly) or a
 * text-heavy front (a heavily-annotated insert) lands near the threshold, and
 * pairing it on that alone would silently mis-pair two unrelated cards.
 *
 * 2 makes "confidently a front" mean <= 2 words and "confidently a back" mean
 * >= 7, leaving 3-6 as ambiguous and routed to the scoring pool, which pays
 * for a classify and can recover. Erring toward the pool costs money; erring
 * toward adjacency costs correctness.
 */
export const ADJACENCY_CONFIDENCE_MARGIN = 2;

/**
 * The free side heuristic — a total function over any count.
 *
 * Used as the degraded fallback when identity resolution is unavailable or
 * reports nothing. `confidentSide` is the stricter variant the adjacency
 * pre-pass uses.
 */
export function sideFromTextCount(textCount: number): CardSide {
  return textCount >= TEXT_COUNT_BACK_THRESHOLD ? "back" : "front";
}

/**
 * Side, but only when the text count is clear of the ambiguous band.
 *
 * Returns null for counts within `ADJACENCY_CONFIDENCE_MARGIN` of the
 * threshold, which the caller reads as "don't guess, pay for a classify".
 */
export function confidentSide(textCount: number): CardSide | null {
  if (textCount >= TEXT_COUNT_BACK_THRESHOLD + ADJACENCY_CONFIDENCE_MARGIN) {
    return "back";
  }
  if (textCount <= TEXT_COUNT_BACK_THRESHOLD - 1 - ADJACENCY_CONFIDENCE_MARGIN) {
    return "front";
  }
  return null;
}

/**
 * Narrow an untrusted side value to a valid `CardSide`, or null.
 *
 * The type system says `side` is already `CardSide | null`, but the value
 * ultimately originates in a model response or an upstream service, so the
 * runtime check is kept — the Python port checks
 * `identity.side in ("front", "back")` for the same reason.
 */
function validSide(side: unknown): CardSide | null {
  return side === "front" || side === "back" ? side : null;
}

/**
 * The side evidence the adjacency pre-pass may act on for one image.
 *
 * A `side` provided on the `BatchImage` is a classification already computed
 * server-side — sunk cost, at least as trustworthy as a confident text count
 * — so it counts as confident evidence and wins over the text-count band.
 * Without one, this is exactly the Python `_confident_side` over
 * `textCount`. (The provided-`side` field is the one NEO-170 contract
 * addition over the Python port, which had no per-image side input.)
 */
export function imageConfidentSide(image: BatchImage): CardSide | null {
  return validSide(image.side) ?? confidentSide(image.textCount);
}

/**
 * Split an upload-ordered batch into confident neighbour pairs and leftovers.
 *
 * Walks the list once. Two consecutive images pair when the free side
 * evidence confidently assigns them *opposite* sides; both are then consumed
 * and the scan advances past them. Anything else — an ambiguous count, two
 * confident fronts in a row, a trailing odd image — is left for the scoring
 * pool, in original order.
 *
 * Advancing by one on a failure (rather than by two) is what lets the scan
 * recover from a single stray at the head of the batch: the stray drops to
 * the pool and the alternation behind it still pairs cleanly.
 */
export function planAdjacency(images: BatchImage[]): {
  pairs: Array<[BatchImage, BatchImage]>;
  leftovers: BatchImage[];
} {
  const pairs: Array<[BatchImage, BatchImage]> = [];
  const leftovers: BatchImage[] = [];

  let index = 0;
  while (index < images.length - 1) {
    const first = images[index];
    const second = images[index + 1];
    const sideA = imageConfidentSide(first);
    const sideB = imageConfidentSide(second);

    if (sideA !== null && sideB !== null && sideA !== sideB) {
      pairs.push([first, second]);
      index += 2;
      continue;
    }

    leftovers.push(first);
    index += 1;
  }

  if (index < images.length) {
    leftovers.push(images[index]);
  }

  return { pairs, leftovers };
}

/**
 * Build the identity-free `PoolCard` for an adjacency-paired image.
 *
 * `identityResolved` stays false, which is the signal downstream that this
 * card's null player/team/card number means "never asked", not "asked and
 * found nothing".
 */
function adjacencyCard(image: BatchImage, side: CardSide): PoolCard {
  return createPoolCard({
    key: image.key,
    side,
    textCount: image.textCount,
    identityResolved: false,
    originalFilename: image.originalFilename ?? null,
  });
}

/**
 * Convert a resolver result into a pool entry.
 *
 * Two rules are applied here rather than inside the pool:
 *
 * - **A front's card number is discarded.** Card numbers are printed on
 *   backs; what a model reads as one on a front is a jersey number, a
 *   copyright year or a subset code. This mirrors the source's
 *   remote-image-service, which drops `cardNumber` unless `side === 'back'`.
 *   The scorer itself stays symmetric — it will happily score a front's card
 *   number if a caller constructs one directly — so the rule lives at
 *   ingestion, where the provenance is known.
 * - **Side falls back through the evidence ladder** — the resolver's side
 *   when it reports a valid one, else the side provided on the `BatchImage`
 *   (the NEO-170 addition), else the text-count heuristic — so every card
 *   still enters the pool with a usable side.
 *
 * Multi-player cards collapse to the first name in `players` (via the
 * `player` alias when the caller supplies it). Pairing only needs a stable
 * handle for name comparison, and the full list stays available to the caller
 * from the resolver result.
 */
export function poolCardFromIdentity(
  image: BatchImage,
  identity: CardIdentity | null,
): PoolCard {
  if (identity === null) {
    return createPoolCard({
      key: image.key,
      side: validSide(image.side) ?? sideFromTextCount(image.textCount),
      textCount: image.textCount,
      identityResolved: false,
      originalFilename: image.originalFilename ?? null,
    });
  }

  const side: CardSide =
    validSide(identity.side) ??
    validSide(image.side) ??
    sideFromTextCount(image.textCount);
  const player =
    identity.player ?? (identity.players.length > 0 ? identity.players[0] : null);
  return createPoolCard({
    key: image.key,
    side,
    player,
    team: identity.team,
    cardNumber: side === "back" ? identity.cardNumber : null,
    textCount: image.textCount,
    identityResolved: true,
    originalFilename: image.originalFilename ?? null,
  });
}

/**
 * Pair fronts to backs across a whole batch of images.
 *
 * @param images every image in the upload, **in upload order**. Order is not
 *   cosmetic: the adjacency pre-pass reads it as scan order, and the pool's
 *   tie-breaking keeps the first-offered candidate.
 * @param opts.resolveIdentity lazy per-image identity callback (a model
 *   classify in production). Called at most once per image, and only for
 *   images the adjacency pre-pass did not claim. May return null or throw;
 *   either degrades that card to the free side heuristic with no identity
 *   rather than failing the batch.
 * @param opts.hashImage optional perceptual-hash callback (16-char lowercase
 *   hex, computed server-side), consulted only when two same-side images
 *   collide on identity. Omitting it degrades those collisions to newer-wins.
 * @param opts.useAdjacency set false to force every image through the scoring
 *   pool. Useful when the caller knows the batch is not in scan order (a
 *   re-upload of loose files, say) and would rather pay for classifies than
 *   risk a wrong adjacency pairing. Defaults to true.
 *
 * @returns a `BatchResult` whose `matches` list holds adjacency pairs first,
 *   then pool pairs in the order the pool resolved them; `unmatched` holds
 *   whatever the pool still had in hand; and `resolverCalls` reports how many
 *   identity calls the batch cost.
 */
export function pairBatch(
  images: BatchImage[],
  opts: {
    resolveIdentity: IdentityResolver;
    hashImage?: ImageHasher | null;
    useAdjacency?: boolean;
  },
): BatchResult {
  const { resolveIdentity, hashImage = null, useAdjacency = true } = opts;
  const ordered = [...images];

  const plan = useAdjacency
    ? planAdjacency(ordered)
    : { pairs: [] as Array<[BatchImage, BatchImage]>, leftovers: ordered };
  const { pairs: adjacentPairs, leftovers } = plan;

  const matches: MatchResult[] = [];

  for (const [first, second] of adjacentPairs) {
    // `planAdjacency` only emits confidently-opposite neighbours, so this
    // re-read of the side evidence cannot disagree with the one that paired
    // them.
    const [frontImage, backImage] =
      imageConfidentSide(first) === "front" ? [first, second] : [second, first];
    matches.push(
      makeMatchResult(
        adjacencyCard(frontImage, "front"),
        adjacencyCard(backImage, "back"),
        "side-only",
        "adjacency",
        0,
      ),
    );
  }

  const pool = new CardPool({ hashImage });
  let resolverCalls = 0;

  for (const image of leftovers) {
    resolverCalls += 1;
    let identity: CardIdentity | null;
    try {
      identity = resolveIdentity(image.key);
    } catch {
      // One bad image must not fail the batch.
      console.warn(`pairing: identity resolution failed for ${image.key}`);
      identity = null;
    }

    const match = pool.addCard(poolCardFromIdentity(image, identity));
    if (match !== null) {
      matches.push(match);
    }
  }

  return {
    matches,
    unmatched: pool.entries(),
    resolverCalls,
  };
}
