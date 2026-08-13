"""Front/back card pairing over a known batch of images.

This is the public surface of the pairing port. It answers one question: given
every image in an upload (a zip, in zip order), which of them are the front and
back of the same physical card?

**Why a batch function and not a service.** The TypeScript original
(`script-frontend/src/utils/cardPool.ts`) is a stateful pool living for the
duration of a filesystem watch session: images trickle in one at a time and the
pool holds the unpaired ones indefinitely. preprocess is stateless FastAPI on
Cloud Run at concurrency 3 / max-instances 3, so an in-process pool would not
survive instance churn. It does not need to — under NEO-149 the whole zip is
known up front, which makes pairing a pure function over a known list. The pool
is kept as an internal implementation detail (`app.pairing.pool.CardPool`)
because its incremental semantics are load-bearing, and is fed in zip order
behind `pair_batch`.

This module deliberately declares **no route and no Pydantic model**. It is a
library; NEO-149 wires it into the zip job.

## The cost model

Identity extraction (player / team / card number / side) is a Haiku call per
image — `app.classify.classify_card`. It is the dominant marginal cost of a
batch and the thing this module is shaped to avoid.

What is *not* a cost is `text_count`: the Vision word-annotation count that
`app.orient.detect_orientation` already produced for every image while
cropping. It is sunk, it is free to re-read, and `text_count >= 5` is the
service's long-standing side heuristic (a card back is dense with stats and
copyright text; a front is a photo with a name on it).

So `pair_batch` runs in two phases:

1. **Adjacency pre-pass** (`_plan_adjacency`) — scanners emit fronts and backs
   in strict alternation, so consecutive images in zip order are usually the
   two sides of one card. Where the free `text_count` heuristic *confidently*
   assigns opposite sides to two neighbours, they are paired immediately and
   **the identity resolver is never called for either of them**.

2. **Scoring pool** — everything the pre-pass could not claim (an odd stray, a
   re-scan, an out-of-order dump, or any image whose text count is too close to
   the threshold to trust) goes through the full ported matcher, resolving
   identity lazily, one call per image, at the moment the pool needs it.

`BatchResult.resolver_calls` reports the resulting spend.
"""

from __future__ import annotations

import logging

from app.classify import ClassifyResult
from app.pairing.dhash import SAME_IMAGE_THRESHOLD, compute_dhash, hamming_distance
from app.pairing.names import player_names_match, team_names_match
from app.pairing.pool import MATCH_ACCEPT_THRESHOLD, CardPool
from app.pairing.types import (
    BatchImage,
    BatchResult,
    CardSide,
    Confidence,
    IdentityResolver,
    ImageHasher,
    MatchResult,
    Mechanism,
    PoolCard,
)

logger = logging.getLogger(__name__)

__all__ = [
    "ADJACENCY_CONFIDENCE_MARGIN",
    "MATCH_ACCEPT_THRESHOLD",
    "SAME_IMAGE_THRESHOLD",
    "TEXT_COUNT_BACK_THRESHOLD",
    "BatchImage",
    "BatchResult",
    "CardPool",
    "CardSide",
    "Confidence",
    "IdentityResolver",
    "ImageHasher",
    "MatchResult",
    "Mechanism",
    "PoolCard",
    "compute_dhash",
    "hamming_distance",
    "pair_batch",
    "player_names_match",
    "side_from_text_count",
    "team_names_match",
]

# Vision word count at or above which an image is treated as a card back.
# Ported from the source's `textDetectionCount >= 5 ? 'back' : 'front'`
# fallback: card backs carry stat tables, career blurbs and copyright lines
# (typically 20+ word annotations), while a front is a photo with a name and
# maybe a team (0-3). 5 sits in the empty middle.
TEXT_COUNT_BACK_THRESHOLD = 5

# How far from `TEXT_COUNT_BACK_THRESHOLD` a text count must sit before the
# adjacency pre-pass will act on it without paying for a classify.
#
# This band has no counterpart in the TypeScript, which only ever used the
# heuristic as a last-resort fallback *after* an AI classify had already
# failed to report a side. Here it is being used as the sole evidence for
# consuming two images without any AI call at all, so it needs a margin: a
# text-light back (a checklist back, a back that cropped badly) or a text-heavy
# front (a heavily-annotated insert) lands near the threshold, and pairing it
# on that alone would silently mis-pair two unrelated cards.
#
# 2 makes "confidently a front" mean <= 2 words and "confidently a back" mean
# >= 7, leaving 3-6 as ambiguous and routed to the scoring pool, which pays for
# a classify and can recover. Erring toward the pool costs money; erring toward
# adjacency costs correctness.
ADJACENCY_CONFIDENCE_MARGIN = 2


def side_from_text_count(text_count: int) -> CardSide:
    """The service's free side heuristic — a total function over any count.

    Used as the degraded fallback when identity resolution is unavailable or
    reports nothing. `_confident_side` is the stricter variant the adjacency
    pre-pass uses.
    """
    return "back" if text_count >= TEXT_COUNT_BACK_THRESHOLD else "front"


def _confident_side(text_count: int) -> CardSide | None:
    """Side, but only when the text count is clear of the ambiguous band.

    Returns None for counts within `ADJACENCY_CONFIDENCE_MARGIN` of the
    threshold, which the caller reads as "don't guess, pay for a classify".
    """
    if text_count >= TEXT_COUNT_BACK_THRESHOLD + ADJACENCY_CONFIDENCE_MARGIN:
        return "back"
    if text_count <= TEXT_COUNT_BACK_THRESHOLD - 1 - ADJACENCY_CONFIDENCE_MARGIN:
        return "front"
    return None


def _plan_adjacency(
    images: list[BatchImage],
) -> tuple[list[tuple[BatchImage, BatchImage]], list[BatchImage]]:
    """Split a zip-ordered batch into confident neighbour pairs and leftovers.

    Walks the list once. Two consecutive images pair when the free heuristic
    confidently assigns them *opposite* sides; both are then consumed and the
    scan advances past them. Anything else — an ambiguous count, two confident
    fronts in a row, a trailing odd image — is left for the scoring pool, in
    original order.

    Advancing by one on a failure (rather than by two) is what lets the scan
    recover from a single stray at the head of the batch: the stray drops to
    the pool and the alternation behind it still pairs cleanly.
    """
    pairs: list[tuple[BatchImage, BatchImage]] = []
    leftovers: list[BatchImage] = []

    index = 0
    while index < len(images) - 1:
        first = images[index]
        second = images[index + 1]
        side_a = _confident_side(first.text_count)
        side_b = _confident_side(second.text_count)

        if side_a is not None and side_b is not None and side_a != side_b:
            pairs.append((first, second))
            index += 2
            continue

        leftovers.append(first)
        index += 1

    if index < len(images):
        leftovers.append(images[index])

    return pairs, leftovers


def _adjacency_card(image: BatchImage, side: CardSide) -> PoolCard:
    """Build the identity-free `PoolCard` for an adjacency-paired image.

    `identity_resolved` stays False, which is the signal downstream that this
    card's null player/team/card number means "never asked", not "asked and
    found nothing".
    """
    return PoolCard(
        key=image.key,
        side=side,
        text_count=image.text_count,
        identity_resolved=False,
        original_filename=image.original_filename,
    )


def pool_card_from_identity(image: BatchImage, identity: ClassifyResult | None) -> PoolCard:
    """Convert a resolver result into a pool entry.

    Two rules are applied here rather than inside the pool:

    - **A front's card number is discarded.** Card numbers are printed on
      backs; what a model reads as one on a front is a jersey number, a
      copyright year or a subset code. This mirrors the source's
      remote-image-service, which drops `card_number` unless `side == 'back'`.
      The scorer itself stays symmetric — it will happily score a front's card
      number if a caller constructs one directly — so the rule lives at
      ingestion, where the provenance is known.
    - **Side falls back to the text-count heuristic** when identity is
      unavailable or reports something unexpected, so every card still enters
      the pool with a usable side.

    Multi-player cards collapse to `ClassifyResult.player`, the first name in
    the list. Pairing only needs a stable handle for name comparison, and the
    full list stays available to the caller from the resolver result.
    """
    if identity is None:
        return PoolCard(
            key=image.key,
            side=side_from_text_count(image.text_count),
            text_count=image.text_count,
            identity_resolved=False,
            original_filename=image.original_filename,
        )

    side: CardSide = (
        identity.side
        if identity.side in ("front", "back")
        else side_from_text_count(image.text_count)
    )
    return PoolCard(
        key=image.key,
        side=side,
        player=identity.player,
        team=identity.team,
        card_number=identity.card_number if side == "back" else None,
        text_count=image.text_count,
        identity_resolved=True,
        original_filename=image.original_filename,
    )


def pair_batch(
    images: list[BatchImage],
    *,
    resolve_identity: IdentityResolver,
    hash_image: ImageHasher | None = None,
    use_adjacency: bool = True,
) -> BatchResult:
    """Pair fronts to backs across a whole batch of images.

    Args:
        images: every image in the upload, **in zip order**. Order is not
            cosmetic: the adjacency pre-pass reads it as scan order, and the
            pool's tie-breaking keeps the first-offered candidate.
        resolve_identity: lazy per-image identity callback (Haiku in
            production). Called at most once per image, and only for images the
            adjacency pre-pass did not claim. May return None or raise; either
            degrades that card to the free side heuristic with no identity
            rather than failing the batch.
        hash_image: optional perceptual-hash callback, consulted only when two
            same-side images collide on identity. Omitting it degrades those
            collisions to newer-wins.
        use_adjacency: set False to force every image through the scoring pool.
            Useful when the caller knows the batch is not in scan order (a
            re-upload of loose files, say) and would rather pay for classifies
            than risk a wrong adjacency pairing.

    Returns:
        A `BatchResult` whose `matches` list holds adjacency pairs first, then
        pool pairs in the order the pool resolved them; `unmatched` holds
        whatever the pool still had in hand; and `resolver_calls` reports how
        many identity calls the batch cost.
    """
    ordered = list(images)

    if use_adjacency:
        adjacent_pairs, leftovers = _plan_adjacency(ordered)
    else:
        adjacent_pairs, leftovers = [], ordered

    matches: list[MatchResult] = []

    for first, second in adjacent_pairs:
        # `_plan_adjacency` only emits confidently-opposite neighbours, so this
        # re-read of the heuristic cannot disagree with the one that paired them.
        if side_from_text_count(first.text_count) == "front":
            front_image, back_image = first, second
        else:
            front_image, back_image = second, first
        matches.append(
            MatchResult(
                front=_adjacency_card(front_image, "front"),
                back=_adjacency_card(back_image, "back"),
                confidence="side-only",
                mechanism="adjacency",
                score=0,
            )
        )

    pool = CardPool(hash_image=hash_image)
    resolver_calls = 0

    for image in leftovers:
        resolver_calls += 1
        try:
            identity = resolve_identity(image.key)
        except Exception:  # noqa: BLE001 - one bad image must not fail the batch
            logger.warning("pairing: identity resolution failed for %s", image.key, exc_info=True)
            identity = None

        match = pool.add_card(pool_card_from_identity(image, identity))
        if match is not None:
            matches.append(match)

    logger.info(
        "pairing: %d image(s) -> %d pair(s) (%d by adjacency), %d unmatched, %d resolver call(s)",
        len(ordered),
        len(matches),
        len(adjacent_pairs),
        pool.size,
        resolver_calls,
    )

    return BatchResult(
        matches=matches,
        unmatched=pool.entries(),
        resolver_calls=resolver_calls,
    )
