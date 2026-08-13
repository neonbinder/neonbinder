"""Shared types for the front/back pairing port.

Ported from script-frontend's `cardPool.ts` (`UnmatchedCard`, `MatchResult`)
with the field names translated to Python conventions and the path-keyed
identity generalised to an opaque `key`.

Two deliberate shape decisions, both load-bearing:

**`PoolCard` is NOT frozen.** `app.classify.ClassifyResult` is
`@dataclass(frozen=True)`, and reusing it as the pool entry would be
convenient but wrong: `CardPool` *mutates* `card.side` when it detects that a
mis-classified image is about to clobber a pooled card of the same side (see
`pool.CardPool._resolve_same_side_collision`). The pool entry therefore has to
be a separate, mutable dataclass. `image_hash` is likewise a mutable
memoisation slot.

**Result objects ARE frozen**, matching the house convention used by
`app.cropper.validator.ValidationResult` and `app.orient.OrientationResult`.

No Pydantic here on purpose. Pydantic models in this service are reserved for
HTTP request/response shapes declared in `app/main.py`; pairing is a pure
library with no route of its own (NEO-149 wires it into the zip job).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from app.classify import ClassifyResult

CardSide = Literal["front", "back"]

#: How a pair was arrived at, surfaced so callers can tell a cheap
#: zip-order/text-count pairing from one the scoring pool actually earned.
Mechanism = Literal["adjacency", "pool"]

#: How much identity evidence backed a pool pairing.
#: - "exact"     : card number matched AND (player or team) matched
#: - "fuzzy"     : player or team matched
#: - "side-only" : no identity evidence at all (adjacency, or the lone
#:                 opposite-side fallback in `CardPool.find_match`)
Confidence = Literal["exact", "fuzzy", "side-only"]

#: Lazily resolves an image's identity fields (player/team/card number/side).
#:
#: In production this is a Haiku call (`app.classify.classify_card`), which is
#: the expensive part of the pipeline — hence the callback shape. Pairing calls
#: it only for images the cheap adjacency pre-pass could not resolve, so the
#: number of invocations is the cost metric this module exists to minimise.
#: Returning None means "identity unavailable"; pairing degrades to the
#: text-count side heuristic rather than failing the batch.
IdentityResolver = Callable[[str], ClassifyResult | None]

#: Resolves an image's perceptual dHash, or None when hashing isn't possible.
#:
#: Mirrors `ImageHasher` in the TypeScript source. Kept as a callback rather
#: than taking bytes directly so the pool never has to hold image bytes in
#: memory for cards it may never need to hash — hashing only happens on a
#: same-side collision, which is rare.
ImageHasher = Callable[[str], int | None]


@dataclass
class PoolCard:
    """One image's pairing state — the mutable pool entry.

    `key` is whatever opaque handle the caller uses to identify an image
    (in the TS source it was an absolute file path; under NEO-149 it will be
    the zip member name). It is the pool's dict key, so it must be unique
    within a batch.

    `identity_resolved` distinguishes "the resolver ran and found nothing"
    from "the resolver was never asked" — an adjacency-paired card has null
    identity fields but was never sent to Haiku, and downstream code needs to
    be able to tell those apart.
    """

    key: str
    side: CardSide
    player: str | None = None
    team: str | None = None
    card_number: str | None = None
    text_count: int = 0
    identity_resolved: bool = False
    original_filename: str | None = None
    image_hash: int | None = None

    @property
    def has_identity(self) -> bool:
        """True when any identity field is populated.

        Gates the side-only fallback and the same-side collision check, both
        of which are only safe on cards carrying no identity signal at all.
        """
        return bool(self.player or self.team or self.card_number)

    @property
    def label(self) -> str:
        """Human-readable label for logs — port of the TS `cardLabel`."""
        name = self.original_filename or self.key
        return f"{self.player or 'unknown'} ({name})"

    @property
    def identity_summary(self) -> str:
        """Raw identity fields for diagnostic logging — port of `cardIdentity`."""
        return (
            f"player={self.player or 'null'} "
            f"team={self.team or 'null'} "
            f"card_number={self.card_number or 'null'}"
        )


@dataclass(frozen=True)
class MatchResult:
    """A paired front/back plus the merged identity for the physical card.

    The merge is **asymmetric on purpose**, and the asymmetry is the whole
    point of pairing rather than just concatenating:

    - *player* and *team* prefer the **front**. Fronts print them large, in a
      display face, usually against a clean background — the most reliable
      read on the card.
    - *card number* comes from the **back**. Card numbers are only printed on
      backs; anything that looks like one on a front is a misread (a jersey
      number, a copyright year, a subset code). See `pairing.pool` for the
      matching-side half of this rule.
    """

    front: PoolCard
    back: PoolCard
    confidence: Confidence
    mechanism: Mechanism
    score: int = 0

    @property
    def player(self) -> str | None:
        return self.front.player or self.back.player

    @property
    def team(self) -> str | None:
        return self.front.team or self.back.team

    @property
    def card_number(self) -> str | None:
        # Back only — a front's card number is never trustworthy.
        return self.back.card_number


@dataclass(frozen=True)
class BatchImage:
    """One input image, in zip order, as `pair_batch` receives it.

    `text_count` is the Vision word-annotation count that
    `app.orient.detect_orientation` already produced for this image during
    cropping. It is a **sunk cost** — no extra API call — which is exactly
    why the adjacency pre-pass is built on it rather than on the `side` field,
    which only exists after a paid Haiku classify.
    """

    key: str
    text_count: int
    original_filename: str | None = None


@dataclass(frozen=True)
class BatchResult:
    """Outcome of `pair_batch` over a whole zip.

    `resolver_calls` is real telemetry, not just a test hook: it is the count
    of `IdentityResolver` invocations the batch needed, i.e. the Haiku spend.
    Comparing it against `len(images)` gives the adjacency pre-pass's saving.
    """

    matches: list[MatchResult] = field(default_factory=list)
    unmatched: list[PoolCard] = field(default_factory=list)
    resolver_calls: int = 0
