"""The scoring card pool — port of script-frontend's `CardPool` class.

`CardPool` is **internal to this package on purpose.** Its semantics are
incremental: cards are offered one at a time, a card that finds no partner is
held, and both the same-side collision resolution and the tie-breaking depend
on the order cards were offered in. That statefulness is load-bearing, so it
survives the port intact — but it is not the surface this service exposes.

preprocess is stateless FastAPI on Cloud Run at concurrency 3 / max-instances
3; a long-lived pool would not survive instance churn, and the original's
watch-session lifetime has no analogue here. Under NEO-149 the entire zip is
known up front, which makes pairing a pure batch function over a known list.
So `app.pairing.pair_batch` owns the lifecycle: it constructs a pool, feeds it
in zip order, and returns. Callers outside this package should use that.

Two behaviours in here are the result of production bugs and must not be
"simplified" back:

1. **Player disagreement is a hard reject, not a penalty.** It was a -1000
   score penalty until card numbers misread off fronts (jersey numbers,
   copyright years) coincidentally matched and outweighed it, pairing
   unrelated cards. Player name is the largest, cleanest text on a card; when
   both sides carry one and they disagree, no other signal may overrule it.

2. **A same-side collision never blindly overwrites the pooled image.** See
   `_resolve_same_side_collision`.
"""

from __future__ import annotations

import logging

from app.pairing.dhash import images_look_identical
from app.pairing.names import player_names_match, team_names_match
from app.pairing.types import CardSide, Confidence, ImageHasher, MatchResult, PoolCard

logger = logging.getLogger(__name__)

# ── Scoring weights ──────────────────────────────────────────────────────────
# Ported verbatim. The absolute magnitudes matter less than the gaps: card
# number dominates everything combined, an exact player beats any team signal,
# and the weakest single accepted signal lands exactly on the threshold.

# Card number is the only field that uniquely identifies a card within a set,
# so an exact hit outweighs every other signal put together.
CARD_NUMBER_EXACT_SCORE = 2000

# Player name after normalisation matched character for character.
PLAYER_EXACT_SCORE = 1000

# Player matched through the fuzzy ladder (surname-only, initials, prefixes).
# Kept well below the exact weight because a shared surname within one set is
# common enough to be a real false-positive source.
PLAYER_FUZZY_SCORE = 400

# Team matched exactly. Far weaker than player: a set has ~30 teams and dozens
# of cards per team, so a team hit narrows the field without identifying a card.
TEAM_EXACT_SCORE = 500

# Team matched by containment ("Chiefs" inside "Kansas City Chiefs"). This is
# the weakest accepted signal and sits exactly on the accept threshold, so a
# fuzzy team match alone is the minimum evidence that will pair two cards.
TEAM_FUZZY_SCORE = 200

# Minimum score to accept a candidate. Set to the weakest single signal so that
# any one identity agreement pairs, but zero agreement never does.
MATCH_ACCEPT_THRESHOLD = 200


def same_card_identity(a: PoolCard, b: PoolCard) -> bool:
    """Do these two cards describe the same physical card?

    Used only for same-side collision detection, which is why it is looser than
    the scorer: it wants "plausibly the same card", not "confidently pairable".

    Player name is authoritative when both sides have one — an explicit
    disagreement there is decisive and card number is not consulted, for the
    same reason it is a hard reject in `CardPool.find_match`. Card number and
    team are fallbacks that only apply when at least one side lacks a player.
    """
    if a.player and b.player:
        return player_names_match(a.player, b.player).match

    if a.card_number and b.card_number:
        if a.card_number.lower().strip() == b.card_number.lower().strip():
            return True

    if a.team and b.team and team_names_match(a.team, b.team).match:
        return True

    return False


def opposite_side(side: CardSide) -> CardSide:
    return "back" if side == "front" else "front"


class CardPool:
    """Holds unpaired cards and matches each new arrival against them.

    Insertion order is significant. The pool is backed by a plain dict, whose
    iteration order is insertion order, and `find_match` improves its best
    candidate on a strict `>` starting from 0 — so when two candidates score
    identically the **first one offered to the pool wins**. The TypeScript
    relied on `Map` iteration order for exactly this; Python dicts give the
    same guarantee, and a test pins it.
    """

    def __init__(self, *, hash_image: ImageHasher | None = None) -> None:
        """
        Args:
            hash_image: optional perceptual-hash callback used only to
                disambiguate same-side collisions. Without it the pool falls
                back to the legacy newer-wins behaviour.
        """
        self._cards: dict[str, PoolCard] = {}
        self._hash_image = hash_image

    @property
    def size(self) -> int:
        return len(self._cards)

    def entries(self) -> list[PoolCard]:
        """Cards currently held, in the order they were offered."""
        return list(self._cards.values())

    def remove(self, key: str) -> bool:
        """Drop a card by key. Returns whether it was present."""
        return self._cards.pop(key, None) is not None

    def add_card(self, card: PoolCard) -> MatchResult | None:
        """Offer a card to the pool.

        Returns a `MatchResult` when the card pairs with one already held (the
        partner is removed from the pool and neither card is retained), or None
        when the card is held awaiting a partner.
        """
        # Collision resolution runs first: a re-scan should evict the stale
        # entry, and a mis-classified image should be flipped, before either
        # one is offered to the matcher.
        self._resolve_same_side_collision(card)

        match = self.find_match(card)
        if match is not None:
            partner = match.back if match.front.key == card.key else match.front
            self._cards.pop(partner.key, None)
            return match

        self._cards[card.key] = card
        return None

    def find_match(self, card: PoolCard) -> MatchResult | None:
        """Find the best-scoring opposite-side partner for `card`.

        Scores every opposite-side card held, rejecting outright any candidate
        whose player name explicitly disagrees, and accepts the best if it
        clears `MATCH_ACCEPT_THRESHOLD`. Falls back to a side-only pairing when
        exactly one opposite-side card is held and neither card carries any
        identity at all.
        """
        wanted = opposite_side(card.side)
        best_candidate: PoolCard | None = None
        best_score = 0
        best_confidence: Confidence = "side-only"

        # Tracked for the side-only fallback below.
        opposite_count = 0
        last_opposite: PoolCard | None = None

        for existing in self._cards.values():
            if existing.side != wanted:
                continue
            opposite_count += 1
            last_opposite = existing

            # Hard reject — see the module docstring. This is deliberately NOT
            # a score penalty; a coincidentally-equal card number must never be
            # able to outweigh an explicit player disagreement.
            if (
                card.player
                and existing.player
                and not player_names_match(card.player, existing.player).match
            ):
                logger.debug(
                    "pairing: rejecting candidate (player mismatch): %s vs %s",
                    card.identity_summary,
                    existing.identity_summary,
                )
                continue

            score = 0
            card_number_matched = False
            player_matched = False
            team_matched = False

            if card.card_number and existing.card_number:
                if card.card_number.lower().strip() == existing.card_number.lower().strip():
                    score += CARD_NUMBER_EXACT_SCORE
                    card_number_matched = True

            if card.player and existing.player:
                pm = player_names_match(card.player, existing.player)
                # `pm.match` is structurally always true here — the hard reject
                # above already skipped every candidate where both players
                # exist and disagree. Kept as written in the source so the two
                # blocks stay independently readable.
                if pm.match:
                    score += PLAYER_EXACT_SCORE if pm.exact else PLAYER_FUZZY_SCORE
                    player_matched = True

            if card.team and existing.team:
                tm = team_names_match(card.team, existing.team)
                if tm.match:
                    score += TEAM_EXACT_SCORE if tm.exact else TEAM_FUZZY_SCORE
                    team_matched = True

            # Strict `>` — ties keep the first-offered candidate.
            if score > best_score:
                best_score = score
                best_candidate = existing
                if card_number_matched and (player_matched or team_matched):
                    best_confidence = "exact"
                elif player_matched or team_matched:
                    best_confidence = "fuzzy"
                else:
                    best_confidence = "side-only"

        if best_candidate is not None and best_score >= MATCH_ACCEPT_THRESHOLD:
            front, back = _orient(card, best_candidate)
            logger.info(
                "pairing: match (%s, score %d): %s <-> %s",
                best_confidence,
                best_score,
                front.label,
                back.label,
            )
            return MatchResult(
                front=front,
                back=back,
                confidence=best_confidence,
                mechanism="pool",
                score=best_score,
            )

        # Side-only fallback. Only safe when there is exactly one opposite-side
        # card to choose from AND neither card has any identity to contradict
        # the pairing — with two candidates and no identity we would be
        # guessing, and a card that *does* have identity failed to match for a
        # reason worth respecting.
        if opposite_count == 1 and last_opposite is not None:
            if not card.has_identity and not last_opposite.has_identity:
                front, back = _orient(card, last_opposite)
                logger.info(
                    "pairing: side-only match (no identity on either card): %s <-> %s",
                    front.label,
                    back.label,
                )
                return MatchResult(
                    front=front,
                    back=back,
                    confidence="side-only",
                    mechanism="pool",
                    score=0,
                )

        return None

    def _resolve_same_side_collision(self, card: PoolCard) -> None:
        """Handle a new card colliding with a held card of the same side.

        Front/back classification is sometimes wrong, so two *different* images
        of the same card can both arrive labelled the same side. Overwriting
        the pooled image would silently lose one of them, so instead:

        - **Same physical scan** (dHash within threshold) — a deliberate
          re-scan. Evict the stale entry and let the newer one through.
        - **Different image** — the incoming card was mis-classified. Flip its
          side so it *pairs* with the held card instead of clobbering it. This
          is the mutation that forces `PoolCard` to be non-frozen.

        Without a working hasher the two cases are indistinguishable, so we
        fall back to the pre-safety-net newer-wins behaviour.

        Only the first colliding card is considered, matching the source.
        """
        if not card.has_identity:
            return

        for existing in self._cards.values():
            if existing.side != card.side:
                continue
            if existing.key == card.key:
                continue
            if not same_card_identity(card, existing):
                continue

            if self._images_are_same(card, existing):
                logger.info(
                    "pairing: same-image re-scan, replacing %s with %s",
                    existing.label,
                    card.label,
                )
                self._cards.pop(existing.key, None)
            else:
                flipped = opposite_side(card.side)
                logger.info(
                    "pairing: same-side collision with a different image — "
                    "flipping %s %s -> %s (keeping %s)",
                    card.label,
                    card.side,
                    flipped,
                    existing.label,
                )
                card.side = flipped
            return

    def _images_are_same(self, a: PoolCard, b: PoolCard) -> bool:
        """Compare two cards' images perceptually.

        Returns True when they look like the same physical scan. With no
        hasher, or when hashing either side fails, conservatively returns True
        so behaviour matches the legacy newer-wins logic rather than flipping a
        side on no evidence.
        """
        if self._hash_image is None:
            return True
        ha = self._ensure_hash(a)
        hb = self._ensure_hash(b)
        if ha is None or hb is None:
            return True
        return images_look_identical(ha, hb)

    def _ensure_hash(self, card: PoolCard) -> int | None:
        """Lazily compute and memoise a card's perceptual hash.

        Hashing is only ever reached on a same-side collision, so most cards in
        a batch are never hashed at all.
        """
        if card.image_hash is not None:
            return card.image_hash
        if self._hash_image is None:
            # Unreachable in practice — `_images_are_same` short-circuits on a
            # missing hasher before ever getting here. Retained from the source
            # as a guard for any future caller of this helper.
            return None
        try:
            value = self._hash_image(card.key)
        except Exception:  # noqa: BLE001 - a hash failure must never fail a batch
            logger.warning("pairing: hashing failed for %s", card.key, exc_info=True)
            return None
        if value is not None:
            card.image_hash = value
        return value


def _orient(card: PoolCard, partner: PoolCard) -> tuple[PoolCard, PoolCard]:
    """Return (front, back) for a matched pair, driven by `card.side`."""
    if card.side == "front":
        return card, partner
    return partner, card
