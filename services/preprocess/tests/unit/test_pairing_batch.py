"""Unit tests for app.pairing's batch entry point.

Covers: the free text-count side heuristic and its confidence band, the
adjacency pre-pass scan (including recovery from a leading stray and a
trailing odd image), identity ingestion rules (a front's card number is
discarded, side falls back to the heuristic, failures degrade rather than
raise), and the headline cost property — adjacency measurably reducing
identity-resolver calls, asserted against a fake resolver that counts them.

No API access anywhere: the resolver is a callable fake, and the hasher is a
dict lookup.
"""

from __future__ import annotations

import pytest

from app.classify import ClassifyResult
from app.pairing import (
    ADJACENCY_CONFIDENCE_MARGIN,
    TEXT_COUNT_BACK_THRESHOLD,
    BatchImage,
    _confident_side,
    _plan_adjacency,
    pair_batch,
    pool_card_from_identity,
    side_from_text_count,
)

# Text counts comfortably clear of the ambiguous band in either direction.
FRONT_WORDS = TEXT_COUNT_BACK_THRESHOLD - 1 - ADJACENCY_CONFIDENCE_MARGIN
BACK_WORDS = TEXT_COUNT_BACK_THRESHOLD + ADJACENCY_CONFIDENCE_MARGIN
# ...and one sitting inside it: too close to the threshold for the pre-pass to
# act on, but still on the "back" side of the plain heuristic, so a card with
# this count degrades to a back when identity is unavailable.
AMBIGUOUS_WORDS = BACK_WORDS - 1


class CountingResolver:
    """Fake `IdentityResolver` that records every call.

    `call_count` is the assertion target for the cost tests: in production each
    call is a Haiku request, so the count is the batch's AI spend.
    """

    def __init__(self, identities: dict[str, ClassifyResult] | None = None) -> None:
        self.identities = identities or {}
        self.calls: list[str] = []

    def __call__(self, key: str) -> ClassifyResult | None:
        self.calls.append(key)
        return self.identities.get(key)

    @property
    def call_count(self) -> int:
        return len(self.calls)


def identity(
    side: str = "front",
    *,
    player: str | None = None,
    team: str | None = None,
    card_number: str | None = None,
) -> ClassifyResult:
    return ClassifyResult(
        players=[player] if player else [],
        team=team,
        card_number=card_number,
        side=side,
        raw_text="{}",
    )


def front_image(key: str) -> BatchImage:
    return BatchImage(key=key, text_count=FRONT_WORDS)


def back_image(key: str) -> BatchImage:
    return BatchImage(key=key, text_count=BACK_WORDS)


def ordered_zip(card_count: int) -> list[BatchImage]:
    """`card_count` cards, each as a front immediately followed by its back."""
    images: list[BatchImage] = []
    for i in range(card_count):
        images.append(front_image(f"card{i}-front.jpg"))
        images.append(back_image(f"card{i}-back.jpg"))
    return images


class TestSideFromTextCount:
    @pytest.mark.parametrize(
        "text_count,expected",
        [
            (0, "front"),
            (TEXT_COUNT_BACK_THRESHOLD - 1, "front"),
            (TEXT_COUNT_BACK_THRESHOLD, "back"),
            (TEXT_COUNT_BACK_THRESHOLD + 50, "back"),
        ],
    )
    def test_threshold(self, text_count, expected):
        assert side_from_text_count(text_count) == expected

    @pytest.mark.parametrize(
        "text_count,expected",
        [
            (0, "front"),
            (FRONT_WORDS, "front"),
            (FRONT_WORDS + 1, None),
            (TEXT_COUNT_BACK_THRESHOLD, None),
            (BACK_WORDS - 1, None),
            (BACK_WORDS, "back"),
            (BACK_WORDS + 50, "back"),
        ],
    )
    def test_confidence_band(self, text_count, expected):
        assert _confident_side(text_count) == expected


class TestPlanAdjacency:
    def test_empty_batch(self):
        assert _plan_adjacency([]) == ([], [])

    def test_single_image_is_a_leftover(self):
        only = front_image("a")
        assert _plan_adjacency([only]) == ([], [only])

    def test_alternating_batch_pairs_completely(self):
        images = ordered_zip(3)
        pairs, leftovers = _plan_adjacency(images)
        assert len(pairs) == 3
        assert leftovers == []

    def test_back_first_ordering_also_pairs(self):
        images = [back_image("b"), front_image("f")]
        pairs, leftovers = _plan_adjacency(images)
        assert pairs == [(images[0], images[1])]
        assert leftovers == []

    def test_two_confident_fronts_in_a_row_are_left_over(self):
        images = [front_image("f1"), front_image("f2")]
        pairs, leftovers = _plan_adjacency(images)
        assert pairs == []
        assert leftovers == images

    def test_ambiguous_text_count_is_never_paired_blind(self):
        images = [front_image("f"), BatchImage(key="?", text_count=AMBIGUOUS_WORDS)]
        pairs, leftovers = _plan_adjacency(images)
        assert pairs == []
        assert leftovers == images

    def test_trailing_odd_image_is_a_leftover(self):
        images = [*ordered_zip(1), front_image("stray")]
        pairs, leftovers = _plan_adjacency(images)
        assert len(pairs) == 1
        assert [i.key for i in leftovers] == ["stray"]

    def test_a_leading_stray_does_not_desynchronise_the_rest(self):
        # Advancing by one on a failed pair (rather than by two) is what lets
        # the scan resynchronise behind a stray.
        images = [front_image("stray"), *ordered_zip(2)]
        pairs, leftovers = _plan_adjacency(images)
        assert len(pairs) == 2
        assert [i.key for i in leftovers] == ["stray"]

    def test_leftovers_keep_zip_order(self):
        images = [front_image("f1"), front_image("f2"), front_image("f3")]
        _, leftovers = _plan_adjacency(images)
        assert [i.key for i in leftovers] == ["f1", "f2", "f3"]


class TestPoolCardFromIdentity:
    def test_a_fronts_card_number_is_discarded(self):
        # Card numbers are printed on backs. Anything read as one off a front
        # is a jersey number, a copyright year or a subset code.
        image = front_image("f")
        result = pool_card_from_identity(image, identity("front", card_number="25"))
        assert result.side == "front"
        assert result.card_number is None

    def test_a_backs_card_number_is_kept(self):
        result = pool_card_from_identity(back_image("b"), identity("back", card_number="25"))
        assert result.card_number == "25"

    def test_player_and_team_carry_through(self):
        result = pool_card_from_identity(
            front_image("f"), identity("front", player="Walker Buehler", team="Dodgers")
        )
        assert result.player == "Walker Buehler"
        assert result.team == "Dodgers"
        assert result.identity_resolved is True

    def test_multi_player_cards_collapse_to_the_first_name(self):
        multi = ClassifyResult(
            players=["Salvador Perez", "Adam Duvall"],
            team=None,
            card_number=None,
            side="front",
            raw_text="{}",
        )
        assert pool_card_from_identity(front_image("f"), multi).player == "Salvador Perez"

    def test_missing_identity_falls_back_to_the_text_count_heuristic(self):
        result = pool_card_from_identity(back_image("b"), None)
        assert result.side == "back"
        assert result.identity_resolved is False
        assert result.has_identity is False

    def test_an_unexpected_side_value_falls_back_to_the_heuristic(self):
        result = pool_card_from_identity(back_image("b"), identity("sideways"))
        assert result.side == "back"

    def test_original_filename_is_preserved(self):
        image = BatchImage(key="member-3", text_count=1, original_filename="IMG_0042.HEIC")
        assert pool_card_from_identity(image, None).original_filename == "IMG_0042.HEIC"


class TestAdjacencyReducesResolverCalls:
    """The cost property this module exists for."""

    def test_a_fully_ordered_zip_costs_zero_identity_calls(self):
        images = ordered_zip(6)
        resolver = CountingResolver()

        result = pair_batch(images, resolve_identity=resolver)

        assert len(result.matches) == 6
        assert result.unmatched == []
        assert resolver.call_count == 0
        assert result.resolver_calls == 0

    def test_the_same_zip_without_adjacency_costs_one_call_per_image(self):
        # The control: the pool alone would classify every single image.
        images = ordered_zip(6)
        resolver = CountingResolver(
            {
                image.key: identity(
                    "front" if image.key.endswith("front.jpg") else "back",
                    player="Walker Buehler",
                )
                for image in images
            }
        )

        result = pair_batch(images, resolve_identity=resolver, use_adjacency=False)

        assert resolver.call_count == len(images) == 12
        assert result.resolver_calls == 12

    def test_only_the_images_adjacency_could_not_claim_are_resolved(self):
        # One card's back cropped badly and came back with an ambiguous text
        # count, so that card — and only that card — costs two Haiku calls.
        images = [
            front_image("a-front"),
            back_image("a-back"),
            front_image("b-front"),
            BatchImage(key="b-back", text_count=AMBIGUOUS_WORDS),
            front_image("c-front"),
            back_image("c-back"),
        ]
        resolver = CountingResolver(
            {
                "b-front": identity("front", player="Walker Buehler"),
                "b-back": identity("back", player="Walker Buehler", card_number="25"),
            }
        )

        result = pair_batch(images, resolve_identity=resolver)

        assert resolver.calls == ["b-front", "b-back"]
        assert result.resolver_calls == 2
        assert len(result.matches) == 3
        assert result.unmatched == []

    def test_adjacency_pairs_are_marked_and_never_resolved(self):
        result = pair_batch(ordered_zip(1), resolve_identity=CountingResolver())
        match = result.matches[0]
        assert match.mechanism == "adjacency"
        assert match.confidence == "side-only"
        assert match.score == 0
        assert match.front.identity_resolved is False
        assert match.back.identity_resolved is False

    def test_adjacency_orients_front_and_back_by_text_count(self):
        images = [back_image("the-back"), front_image("the-front")]
        result = pair_batch(images, resolve_identity=CountingResolver())
        match = result.matches[0]
        assert match.front.key == "the-front"
        assert match.front.side == "front"
        assert match.back.key == "the-back"
        assert match.back.side == "back"


class TestPairBatchThroughThePool:
    def test_pool_matches_are_marked_and_carry_confidence(self):
        images = [front_image("f"), BatchImage(key="b", text_count=AMBIGUOUS_WORDS)]
        resolver = CountingResolver(
            {
                "f": identity("front", player="Walker Buehler", team="Dodgers"),
                "b": identity("back", player="Walker Buehler", card_number="25"),
            }
        )

        result = pair_batch(images, resolve_identity=resolver)

        assert len(result.matches) == 1
        match = result.matches[0]
        assert match.mechanism == "pool"
        assert match.confidence == "fuzzy"
        assert match.front.key == "f"
        assert match.back.key == "b"

    def test_merged_identity_is_asymmetric(self):
        images = [front_image("f"), front_image("f2")]
        resolver = CountingResolver(
            {
                # A card number read off the front is dropped at ingestion, so
                # the merged number can only ever come from the back.
                "f": identity("front", player="BUEHLER", team="Dodgers", card_number="99"),
                "f2": identity(
                    "back",
                    player="Walker Buehler",
                    team="Los Angeles Dodgers",
                    card_number="25",
                ),
            }
        )

        match = pair_batch(images, resolve_identity=resolver).matches[0]

        assert match.player == "BUEHLER"
        assert match.team == "Dodgers"
        assert match.card_number == "25"

    def test_unpairable_cards_are_surfaced_as_unmatched(self):
        images = [front_image("f1"), front_image("f2")]
        resolver = CountingResolver(
            {
                "f1": identity("front", player="Walker Buehler"),
                "f2": identity("front", player="Clayton Kershaw"),
            }
        )

        result = pair_batch(images, resolve_identity=resolver)

        assert result.matches == []
        assert [c.key for c in result.unmatched] == ["f1", "f2"]

    def test_a_resolver_returning_none_degrades_instead_of_failing(self):
        images = [front_image("f"), front_image("f2")]
        result = pair_batch(images, resolve_identity=CountingResolver())
        # Both fall back to the text-count heuristic, so both read as fronts
        # and neither pairs — but the batch completes.
        assert result.resolver_calls == 2
        assert [c.side for c in result.unmatched] == ["front", "front"]

    def test_a_raising_resolver_degrades_instead_of_failing(self, caplog):
        def boom(_key: str):
            raise RuntimeError("anthropic exploded")

        images = [front_image("f"), BatchImage(key="b", text_count=AMBIGUOUS_WORDS)]
        result = pair_batch(images, resolve_identity=boom)

        # No identity on either card and exactly one opposite-side candidate,
        # so the side-only fallback still pairs them.
        assert result.resolver_calls == 2
        assert len(result.matches) == 1
        assert result.matches[0].confidence == "side-only"
        assert "identity resolution failed" in caplog.text

    def test_the_hasher_is_threaded_through_to_the_pool(self):
        hashed: list[str] = []

        def hasher(key: str) -> int | None:
            hashed.append(key)
            return 0

        # Two same-side images of the same card force a collision, which is the
        # only path that reaches the hasher.
        images = [front_image("f1"), front_image("f2")]
        resolver = CountingResolver(
            {
                "f1": identity("front", player="Walker Buehler"),
                "f2": identity("front", player="Walker Buehler"),
            }
        )

        pair_batch(images, resolve_identity=resolver, hash_image=hasher)

        assert hashed == ["f2", "f1"]

    def test_an_empty_batch_is_a_no_op(self):
        result = pair_batch([], resolve_identity=CountingResolver())
        assert result.matches == []
        assert result.unmatched == []
        assert result.resolver_calls == 0
