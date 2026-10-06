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
 * **`PoolCard` is a separate object from the resolver's `CardIdentity`.** It
 * carries pairing-only state the resolver knows nothing about (the side
 * `label` and whether a person set it, the user's splits, the text count),
 * and `imageHash` is a mutable memoisation slot the pool fills lazily. The
 * pool never rewrites a card's `label`: which image of a pair is the front is
 * decided per pair by `orientPair` (`pool.ts`), not stored on the card.
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
 * How a pair was arrived at, surfaced so callers can tell a scan-order
 * pairing from one the scoring pool actually earned.
 *
 * This package only ever produces "pool". "adjacency" is kept in the union
 * because the pipeline's guarded scan-order fallback over the pool's
 * leftovers (in `placeholderPairing.ts`) labels its pairs with it, and stored
 * pair rows carry it.
 */
export type Mechanism = "adjacency" | "pool";

/**
 * Which rule decided the front and back of a pair — see `orientPair` in
 * `pool.ts`.
 *
 * - "user"  : a person set at least one image's side, and that decided it
 * - "text"  : one image carries clearly more Vision text, so it is the back
 * - "label" : text counts were close; the classifier's labels disagreed and
 *             broke the tie
 *
 * There is deliberately no "order" rule: arrival or entry order never decides
 * a side.
 */
export type OrientRule = "user" | "text" | "label";

/**
 * How much evidence backed a pool pairing — a band of the match SCORE, not a
 * checklist of which fields agreed.
 *
 * - "exact"     : score above EXACT_CONFIDENCE_THRESHOLD
 * - "fuzzy"     : accepted, but below it
 * - "side-only" : paired with no identity evidence at all (the lone
 *                 orientable-candidate fallback in `CardPool.findMatch`, or
 *                 the pipeline's scan-order fallback)
 *
 * It used to be the checklist `cardNumberMatched && (player || team)`, ported
 * faithfully from the Python original. That rule was effectively unreachable:
 * it needs a card number on both halves, and a card number is printed on the
 * back. The score already weighed every signal properly and was only ever
 * used to decide whether to pair at all; banding it is what makes the
 * distinction mean something.
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
 * `side` is the classifier's label, typed to the two valid values or null
 * (the classifier returns null when it is unsure). The value ultimately comes
 * from a model response, so consumers still runtime-check it and treat
 * anything unexpected as no label. It is only ever a tie-breaker — see
 * `orientPair`.
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
 * Called once per image. In the pipeline it is a lookup of the identity the
 * preprocess classify already stored on the image row; the callback shape is
 * kept so an image's identity is only read when the pool needs it. Returning
 * null means "identity unavailable"; that card then pairs on side evidence
 * alone (see the side-only fallback) rather than failing the batch.
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
 * compare — hashing only matters when a new image carries the same identity
 * as a held one (a possible re-scan; see `CardPool.evictRescan`).
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
 * `identityResolved` distinguishes "the resolver ran and returned identity"
 * from "no identity was available for this image" (the resolver returned null
 * or threw).
 */
export interface PoolCard {
  key: string;
  /**
   * The side this image is LABELLED, or null when nothing labelled it. A
   * classifier label is a weak, tie-break-only signal (it calls photo-heavy
   * backs "front"); a user-set label (`labelByUser`) is authoritative. Either
   * way the pool never rewrites it — `orientPair` decides each pair's front
   * and back from both images' evidence.
   */
  label: CardSide | null;
  /** True when a person set `label`, which makes it decide the pair's sides. */
  labelByUser: boolean;
  /**
   * Keys this card must never be auto-paired with, because the user split them
   * apart. A HARD reject in `CardPool.findMatch`, never a score penalty — a
   * strong identity agreement must not be able to outvote an explicit human
   * decision, which is the same reasoning as the player-disagreement reject.
   */
  unpairedFrom: readonly string[];

  /**
   * Position in the scan, when the caller knows it. Two cards one apart were
   * photographed back to back, which is weak but real evidence they are the
   * two sides of one card — see ADJACENCY_SCORE. Null when unknown; the pool
   * simply scores no adjacency bonus then. Never consulted for which side is
   * which.
   */
  order: number | null;
  player: string | null;
  team: string | null;
  cardNumber: string | null;
  textCount: number;
  identityResolved: boolean;
  originalFilename: string | null;
  /** Cached perceptual dHash (lowercase hex), lazily memoised on a possible re-scan. */
  imageHash: string | null;
}

/** Everything `createPoolCard` accepts; only `key` is required. */
export interface PoolCardInit {
  key: string;
  label?: CardSide | null;
  labelByUser?: boolean;
  order?: number | null;
  unpairedFrom?: readonly string[];
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
 * null identity fields, `textCount` 0, `identityResolved` false — plus no
 * label and `labelByUser` false.
 */
export function createPoolCard(init: PoolCardInit): PoolCard {
  return {
    key: init.key,
    label: init.label ?? null,
    labelByUser: init.labelByUser ?? false,
    order: init.order ?? null,
    unpairedFrom: init.unpairedFrom ?? [],
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
 * Gates the side-only fallback (only safe when neither card carries any
 * identity signal) and the re-scan check (which needs one to compare).
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
 * - *card number* comes from the **back** — the image `orientPair` decided is
 *   the back. The card number is printed on the back; a number read off a
 *   front image is usually a jersey number, a copyright year or a subset
 *   code. Each image still keeps the number it read (both feed the scorer,
 *   where agreement is evidence), but only the back's names the pair.
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
  /** Which rule decided `front` and `back` — see `orientPair`. */
  readonly orientedBy: OrientRule;
  /** Merged player: the front's read when it has one, else the back's. */
  readonly player: string | null;
  /** Merged team: the front's read when it has one, else the back's. */
  readonly team: string | null;
  /** The oriented back's read only — never the front's. */
  readonly cardNumber: string | null;
}

/** Construct a frozen `MatchResult` with the asymmetric merge wired up. */
export function makeMatchResult(
  front: PoolCard,
  back: PoolCard,
  confidence: Confidence,
  mechanism: Mechanism,
  score: number,
  orientedBy: OrientRule,
): MatchResult {
  const result: MatchResult = {
    front,
    back,
    confidence,
    mechanism,
    score,
    orientedBy,
    get player(): string | null {
      return front.player || back.player;
    },
    get team(): string | null {
      return front.team || back.team;
    },
    get cardNumber(): string | null {
      // The oriented back's read only — see the MatchResult doc comment.
      return back.cardNumber;
    },
  };
  return Object.freeze(result);
}

/**
 * One input image as `pairBatch` receives it.
 *
 * `textCount` is the OCR/Vision word-annotation count already produced for
 * this image during preprocessing. It is the primary side signal: a back
 * carries the card number, bio or stats and fine print, so within a pair the
 * image with clearly more text is the back (see `orientPair`).
 *
 * `label`, when present, is a side label already stored for the image — the
 * classifier's, or a person's when `labelByUser` is true. A user-set label
 * always wins and decides the pair's sides; a classifier label here is used
 * only when the resolver reports no side of its own, and only ever breaks a
 * tie between close text counts. See `poolCardFromIdentity`.
 */
export interface BatchImage {
  key: string;
  textCount: number;
  /** Keys the user split this image from. See `PoolCard.unpairedFrom`. */
  unpairedFrom?: readonly string[];
  /** Position in the scan. See `PoolCard.order`. */
  order?: number | null;
  originalFilename?: string | null;
  label?: CardSide | null;
  /** True when a person set `label`. See `PoolCard.labelByUser`. */
  labelByUser?: boolean;
}

/**
 * Outcome of `pairBatch` over a whole upload.
 *
 * `resolverCalls` is the count of `IdentityResolver` invocations the batch
 * made — one per image.
 */
export interface BatchResult {
  matches: MatchResult[];
  unmatched: PoolCard[];
  resolverCalls: number;
}
