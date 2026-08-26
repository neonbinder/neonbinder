/**
 * Shared types for the front/back pairing port (NEO-170).
 *
 * Ported from the preprocess service's audited Python port
 * (`services/preprocess/app/pairing/types.py`), itself ported from
 * script-frontend's `cardPool.ts` (`UnmatchedCard`, `MatchResult`) with the
 * path-keyed identity generalised to an opaque `key`. Field names use
 * camelCase per this package's contract (`cardNumber`, `textCount`).
 *
 * Two deliberate shape decisions, both load-bearing:
 *
 * **`PoolCard` is NOT immutable.** Reusing the resolver's `CardIdentity` as
 * the pool entry would be convenient but wrong: `CardPool` *mutates*
 * `card.side` when it detects that a mis-classified image is about to clobber
 * a pooled card of the same side (see `pool.ts`,
 * `CardPool.resolveSameSideCollision`). The pool entry therefore has to be a
 * separate, mutable object. `imageHash` is likewise a mutable memoisation
 * slot.
 *
 * **Result objects ARE frozen** (`Object.freeze` in `makeMatchResult`),
 * matching the Python port's frozen dataclasses for `MatchResult`,
 * `BatchImage` and `BatchResult`.
 *
 * This module is pure TypeScript with zero dependencies and no Node APIs so
 * it can run in the default Convex runtime. It declares no Convex function of
 * its own — it is a library the NEO-170 pipeline imports.
 */

/** Which physical side of a card an image shows. */
export type CardSide = "front" | "back";

/**
 * How a pair was arrived at, surfaced so callers can tell a cheap
 * zip-order/text-count pairing from one the scoring pool actually earned.
 */
export type Mechanism = "adjacency" | "pool";

/**
 * How much evidence backed a pool pairing — a band of the match SCORE, not a
 * checklist of which fields agreed.
 *
 * - "exact"     : score above EXACT_CONFIDENCE_THRESHOLD
 * - "fuzzy"     : accepted, but below it
 * - "side-only" : paired with no identity evidence at all (the lone
 *                 opposite-side fallback in `CardPool.findMatch`, or the
 *                 adjacency pass in `pairBatch`)
 *
 * It used to be the checklist `cardNumberMatched && (player || team)`, ported
 * faithfully from the Python original. That rule was UNREACHABLE: it needs a
 * card number on both halves, and no set prints the number on the front, so
 * `exact` never occurred for a real pair. The score already weighed every
 * signal properly and was only ever used to decide whether to pair at all;
 * banding it is what makes the distinction mean something.
 */
export type Confidence = "exact" | "fuzzy" | "side-only";

/**
 * The identity fields pairing consumes for one image — the camelCase mirror
 * of the preprocess service's `ClassifyResult` (minus `rawText`, which
 * pairing never reads).
 *
 * `players` is the canonical list; `player` is a back-compat single-name
 * alias that should be the first entry or null. In the Python original
 * `player` is a derived property (`players[0] or None`); TypeScript
 * interfaces cannot derive fields, so callers supply both and
 * `poolCardFromIdentity` falls back to `players[0]` when `player` is null.
 *
 * `side` is typed to the two valid values, but the value ultimately comes
 * from a model response, so consumers still runtime-check it and fall back to
 * the text-count heuristic on anything unexpected.
 */
export interface CardIdentity {
  players: string[];
  player: string | null;
  team: string | null;
  cardNumber: string | null;
  side: CardSide | null;
}

/**
 * Lazily resolves an image's identity fields (player/team/card number/side).
 *
 * In production this is a Haiku classify call — the expensive part of the
 * pipeline, hence the callback shape. Pairing calls it only for images the
 * cheap adjacency pre-pass could not resolve, so the number of invocations is
 * the cost metric this module exists to minimise. Returning null means
 * "identity unavailable"; pairing degrades to the text-count side heuristic
 * rather than failing the batch.
 */
export type IdentityResolver = (key: string) => CardIdentity | null;

/**
 * Resolves an image's perceptual dHash, or null when hashing isn't possible.
 *
 * Mirrors `ImageHasher` in the TypeScript source and the Python port, with
 * one contract change: the hash is a 16-character lowercase hex string
 * computed server-side (this package never hashes image bytes — the default
 * Convex runtime has no image decoding, and doesn't need any; see
 * `dhash.ts`). Kept as a callback rather than taking the hash eagerly so the
 * pool never has to pay for a hash lookup for cards it may never need to
 * compare — hashing only matters on a same-side collision, which is rare.
 */
export type ImageHasher = (key: string) => string | null;

/**
 * One image's pairing state — the mutable pool entry.
 *
 * `key` is whatever opaque handle the caller uses to identify an image
 * (an absolute file path in the TS original, a zip member name in the Python
 * port, a storage id under NEO-170). It is the pool's Map key, so it must be
 * unique within a batch.
 *
 * `identityResolved` distinguishes "the resolver ran and found nothing" from
 * "the resolver was never asked" — an adjacency-paired card has null identity
 * fields but was never sent to the resolver, and downstream code needs to be
 * able to tell those apart.
 */
export interface PoolCard {
  key: string;
  side: CardSide;
  /**
   * Position in the scan, when the caller knows it. Two cards one apart were
   * photographed back to back, which is weak but real evidence they are the
   * two sides of one card — see ADJACENCY_SCORE. Null when unknown; the pool
   * simply scores no adjacency bonus then.
   */
  order: number | null;
  player: string | null;
  team: string | null;
  cardNumber: string | null;
  textCount: number;
  identityResolved: boolean;
  originalFilename: string | null;
  /** Cached perceptual dHash (lowercase hex), lazily memoised on a same-side collision. */
  imageHash: string | null;
}

/** Everything `createPoolCard` accepts; only `key` and `side` are required. */
export interface PoolCardInit {
  key: string;
  side: CardSide;
  order?: number | null;
  player?: string | null;
  team?: string | null;
  cardNumber?: string | null;
  textCount?: number;
  identityResolved?: boolean;
  originalFilename?: string | null;
  imageHash?: string | null;
}

/**
 * Build a `PoolCard` with the same defaults as the Python dataclass:
 * null identity fields, `textCount` 0, `identityResolved` false.
 */
export function createPoolCard(init: PoolCardInit): PoolCard {
  return {
    key: init.key,
    side: init.side,
    order: init.order ?? null,
    player: init.player ?? null,
    team: init.team ?? null,
    cardNumber: init.cardNumber ?? null,
    textCount: init.textCount ?? 0,
    identityResolved: init.identityResolved ?? false,
    originalFilename: init.originalFilename ?? null,
    imageHash: init.imageHash ?? null,
  };
}

/**
 * True when any identity field is populated.
 *
 * Gates the side-only fallback and the same-side collision check, both of
 * which are only safe on cards carrying no identity signal at all.
 */
export function hasIdentity(card: PoolCard): boolean {
  return Boolean(card.player || card.team || card.cardNumber);
}

/**
 * Human-readable label for logs — port of the TS `cardLabel` / Python
 * `PoolCard.label`.
 */
export function cardLabel(card: PoolCard): string {
  const name = card.originalFilename || card.key;
  return `${card.player || "unknown"} (${name})`;
}

/**
 * Raw identity fields for diagnostic logging — port of `cardIdentity` /
 * Python `PoolCard.identity_summary`.
 */
export function identitySummary(card: PoolCard): string {
  return (
    `player=${card.player || "null"} ` +
    `team=${card.team || "null"} ` +
    `cardNumber=${card.cardNumber || "null"}`
  );
}

/**
 * A paired front/back plus the merged identity for the physical card.
 *
 * The merge is **asymmetric on purpose**, and the asymmetry is the whole
 * point of pairing rather than just concatenating:
 *
 * - *player* and *team* prefer the **front**. Fronts print them large, in a
 *   display face, usually against a clean background — the most reliable
 *   read on the card.
 * - *card number* comes from the **back**. Card numbers are only printed on
 *   backs; anything that looks like one on a front is a misread (a jersey
 *   number, a copyright year, a subset code). See `pool.ts` for the
 *   matching-side half of this rule.
 *
 * The merged fields are getters over `front`/`back` (mirroring the Python
 * properties), and the result object is frozen.
 */
export interface MatchResult {
  readonly front: PoolCard;
  readonly back: PoolCard;
  readonly confidence: Confidence;
  readonly mechanism: Mechanism;
  readonly score: number;
  /** Merged player: the front's read when it has one, else the back's. */
  readonly player: string | null;
  /** Merged team: the front's read when it has one, else the back's. */
  readonly team: string | null;
  /** Back only — a front's card number is never trustworthy. */
  readonly cardNumber: string | null;
}

/** Construct a frozen `MatchResult` with the asymmetric merge wired up. */
export function makeMatchResult(
  front: PoolCard,
  back: PoolCard,
  confidence: Confidence,
  mechanism: Mechanism,
  score: number,
): MatchResult {
  const result: MatchResult = {
    front,
    back,
    confidence,
    mechanism,
    score,
    get player(): string | null {
      return front.player || back.player;
    },
    get team(): string | null {
      return front.team || back.team;
    },
    get cardNumber(): string | null {
      // Back only — a front's card number is never trustworthy.
      return back.cardNumber;
    },
  };
  return Object.freeze(result);
}

/**
 * One input image, in upload order, as `pairBatch` receives it.
 *
 * `textCount` is the OCR/Vision word-annotation count already produced for
 * this image during preprocessing. It is a **sunk cost** — no extra API call
 * — which is exactly why the adjacency pre-pass is built on it rather than on
 * a paid classify.
 *
 * `side`, when present, is a side classification already computed server-side
 * (this is a NEO-170 contract addition over the Python `BatchImage`, which
 * carried only key/textCount/originalFilename). A provided side is treated as
 * authoritative over the text-count heuristic, and the adjacency pre-pass
 * accepts it as confident evidence — see `pairBatch.ts`.
 */
export interface BatchImage {
  key: string;
  textCount: number;
  /** Position in the scan. See `PoolCard.order`. */
  order?: number | null;
  originalFilename?: string | null;
  side?: CardSide | null;
}

/**
 * Outcome of `pairBatch` over a whole upload.
 *
 * `resolverCalls` is real telemetry, not just a test hook: it is the count of
 * `IdentityResolver` invocations the batch needed, i.e. the classify spend.
 * Comparing it against `images.length` gives the adjacency pre-pass's saving.
 */
export interface BatchResult {
  matches: MatchResult[];
  unmatched: PoolCard[];
  resolverCalls: number;
}
