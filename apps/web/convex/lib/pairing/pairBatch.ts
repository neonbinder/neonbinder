/**
 * Front/back card pairing over a known batch of images.
 *
 * This is the public surface of the pairing port (NEO-150 → NEO-170). It
 * answers one question: given every image in an upload, which of them are the
 * front and back of the same physical card, and which image is which?
 *
 * **Why a batch function and not a long-lived pool.** The TypeScript original
 * (`script-frontend/src/utils/cardPool.ts`) is a stateful pool living for the
 * duration of a filesystem watch session: images trickle in one at a time and
 * the pool holds the unpaired ones indefinitely. Convex functions are
 * short-lived, so an in-process pool would not survive across invocations. It
 * does not need to — the whole upload is known up front, which makes pairing
 * a pure function over a known list. The pool is kept as an internal
 * implementation detail (`pool.ts`, `CardPool`) and fed behind `pairBatch`.
 *
 * This module is a pure library: zero dependencies, no Node APIs, no Convex
 * function of its own. The NEO-170 pipeline imports it.
 *
 * ## The model (NEO-327)
 *
 * Every image goes through the scoring pool. Two images pair because they are
 * the same card — player, team and card number, scored in `pool.ts` — and
 * only then is the pair oriented (`orientPair`): a person's side label
 * decides; otherwise the image with clearly more Vision text is the back;
 * otherwise disagreeing classifier labels break the tie; otherwise the two
 * are not a front/back pair (a duplicate copy). The classifier's label is
 * never a gate, and arrival or entry order never decides a side.
 *
 * Each image keeps whatever it read — including a card number read off a
 * front — and the pair's card number is the oriented back's
 * (`makeMatchResult`).
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
} from "./types";

/**
 * Narrow an untrusted side value to a valid `CardSide`, or null.
 *
 * The type system says a side is already `CardSide | null`, but the value
 * ultimately originates in a model response or a stored row, so the runtime
 * check is kept — the Python port checks `identity.side in ("front",
 * "back")` for the same reason.
 */
function validSide(side: unknown): CardSide | null {
  return side === "front" || side === "back" ? side : null;
}

/**
 * The label a pool card carries, and whether a person set it.
 *
 * A user-set label on the image always wins: it is an explicit human decision
 * and `orientPair` lets it decide the pair. Otherwise the ladder is the
 * resolver's side, then the image's stored (classifier) label, then none —
 * and a classifier label only ever breaks a text-count tie.
 */
function labelFor(
  image: BatchImage,
  identity: CardIdentity | null,
): { label: CardSide | null; labelByUser: boolean } {
  const stored = validSide(image.label);
  if (image.labelByUser === true && stored !== null) {
    return { label: stored, labelByUser: true };
  }
  return {
    label: validSide(identity?.side) ?? stored ?? null,
    labelByUser: false,
  };
}

/**
 * Convert a resolver result into a pool entry.
 *
 * - **Every image keeps the card number it read.** Which image is the back is
 *   not known until the pair is oriented, so nothing is dropped by label here.
 *   The scorer treats agreement as strong evidence and disagreement as no
 *   evidence (a front's read is often a jersey number), and the pair's card
 *   number is the oriented back's.
 * - **The label follows `labelFor`.** It may be null; the pool orients pairs
 *   from text counts first and needs no label to do it.
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
  const { label, labelByUser } = labelFor(image, identity);

  if (identity === null) {
    return createPoolCard({
      key: image.key,
      order: image.order ?? null,
      unpairedFrom: image.unpairedFrom ?? [],
      label,
      labelByUser,
      textCount: image.textCount,
      identityResolved: false,
      originalFilename: image.originalFilename ?? null,
    });
  }

  const player =
    identity.player ?? (identity.players.length > 0 ? identity.players[0] : null);
  return createPoolCard({
    key: image.key,
    order: image.order ?? null,
    unpairedFrom: image.unpairedFrom ?? [],
    label,
    labelByUser,
    player,
    team: identity.team,
    cardNumber: identity.cardNumber,
    textCount: image.textCount,
    identityResolved: true,
    originalFilename: image.originalFilename ?? null,
  });
}

/**
 * Pair fronts to backs across a whole batch of images.
 *
 * @param images every image in the upload. The pool is fed in this order,
 *   which only ever breaks an exact score tie between two candidates (the
 *   first offered wins); it never decides which image is the front.
 * @param opts.resolveIdentity per-image identity callback. Called exactly
 *   once per image. May return null or throw; either leaves that card with no
 *   identity (it can still pair through the side-only fallback) rather than
 *   failing the batch.
 * @param opts.hashImage optional perceptual-hash callback (16-char lowercase
 *   hex, computed server-side), consulted only when a new image shares an
 *   identity with a held one, to recognise a deliberate re-scan. Omitting it
 *   means no image is ever evicted as a re-scan.
 *
 * @returns a `BatchResult` whose `matches` list holds pairs in the order the
 *   pool resolved them; `unmatched` holds whatever the pool still had in
 *   hand; and `resolverCalls` reports how many identity calls the batch made.
 */
export function pairBatch(
  images: BatchImage[],
  opts: {
    resolveIdentity: IdentityResolver;
    hashImage?: ImageHasher | null;
  },
): BatchResult {
  const { resolveIdentity, hashImage = null } = opts;

  const matches: MatchResult[] = [];
  const pool = new CardPool({ hashImage });
  let resolverCalls = 0;

  for (const image of images) {
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
