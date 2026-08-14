"""Unit tests for app.pairing.pool.

Covers the ported matcher end to end: every scoring weight (parametrized off
the production constants), the accept threshold, the three confidence levels,
the player-disagreement hard reject beating a coincidentally-equal card number,
surname-only fronts, the side-only fallback and its two guards, insertion-order
tie-breaking, the asymmetric post-pair merge, and same-side collision
resolution in all four hasher states (same image / different image / no hasher
/ hasher failure).

The perceptual hasher is faked as a dict lookup — dHash itself is exercised in
test_pairing_dhash.py, and the pool only cares about the distance verdict.
"""

from __future__ import annotations

import pytest

from app.pairing.dhash import SAME_IMAGE_THRESHOLD
from app.pairing.pool import (
    CARD_NUMBER_EXACT_SCORE,
    MATCH_ACCEPT_THRESHOLD,
    PLAYER_EXACT_SCORE,
    PLAYER_FUZZY_SCORE,
    TEAM_EXACT_SCORE,
    TEAM_FUZZY_SCORE,
    CardPool,
    opposite_side,
    same_card_identity,
)
from app.pairing.types import PoolCard

# Two hashes far enough apart that the pool must read them as different images.
HASH_A = 0
HASH_FAR = (1 << (SAME_IMAGE_THRESHOLD + 5)) - 1
# ...and one close enough to read as the same physical scan.
HASH_NEAR = (1 << (SAME_IMAGE_THRESHOLD - 1)) - 1


def card(key: str, side: str = "front", **fields) -> PoolCard:
    return PoolCard(key=key, side=side, identity_resolved=True, **fields)


def hasher_from(mapping: dict[str, int | None]):
    """Fake ImageHasher backed by a dict."""
    return lambda key: mapping.get(key)


class TestPoolBasics:
    def test_starts_empty(self):
        assert CardPool().size == 0

    def test_holds_an_unmatched_card(self):
        pool = CardPool()
        assert pool.add_card(card("a", "front", player="Walker Buehler")) is None
        assert pool.size == 1
        assert [c.key for c in pool.entries()] == ["a"]

    def test_remove_reports_presence(self):
        pool = CardPool()
        pool.add_card(card("a", "front", player="Walker Buehler"))
        assert pool.remove("a") is True
        assert pool.remove("a") is False

    def test_same_side_cards_never_match(self):
        pool = CardPool()
        pool.add_card(card("a", "front", player="Walker Buehler"))
        assert pool.add_card(card("b", "front", player="Clayton Kershaw")) is None
        assert pool.size == 2

    def test_a_match_removes_the_partner_and_retains_neither(self):
        pool = CardPool()
        pool.add_card(card("back", "back", player="Walker Buehler"))
        assert pool.add_card(card("front", "front", player="Walker Buehler")) is not None
        assert pool.size == 0

    def test_opposite_side_is_an_involution(self):
        assert opposite_side("front") == "back"
        assert opposite_side(opposite_side("front")) == "front"


class TestScoringWeights:
    """Each signal in isolation, scored against the production constant."""

    @pytest.mark.parametrize(
        "front_fields,back_fields,expected_score,expected_confidence",
        [
            pytest.param(
                {"card_number": "25"},
                {"card_number": "25"},
                CARD_NUMBER_EXACT_SCORE,
                "side-only",
                id="card-number-exact",
            ),
            pytest.param(
                {"player": "Walker Buehler"},
                {"player": "Walker Buehler"},
                PLAYER_EXACT_SCORE,
                "fuzzy",
                id="player-exact",
            ),
            pytest.param(
                {"player": "BUEHLER"},
                {"player": "Walker Buehler"},
                PLAYER_FUZZY_SCORE,
                "fuzzy",
                id="player-fuzzy",
            ),
            pytest.param(
                {"team": "Dodgers"},
                {"team": "Dodgers"},
                TEAM_EXACT_SCORE,
                "fuzzy",
                id="team-exact",
            ),
            pytest.param(
                {"team": "Dodgers"},
                {"team": "Los Angeles Dodgers"},
                TEAM_FUZZY_SCORE,
                "fuzzy",
                id="team-fuzzy",
            ),
        ],
    )
    def test_single_signal(self, front_fields, back_fields, expected_score, expected_confidence):
        pool = CardPool()
        pool.add_card(card("b", "back", **back_fields))
        match = pool.add_card(card("f", "front", **front_fields))
        assert match is not None
        assert match.score == expected_score
        assert match.confidence == expected_confidence
        assert match.mechanism == "pool"

    def test_signals_are_additive(self):
        pool = CardPool()
        pool.add_card(card("b", "back", player="Walker Buehler", team="Dodgers", card_number="25"))
        match = pool.add_card(
            card("f", "front", player="Walker Buehler", team="Dodgers", card_number="25")
        )
        assert match is not None
        assert match.score == CARD_NUMBER_EXACT_SCORE + PLAYER_EXACT_SCORE + TEAM_EXACT_SCORE

    def test_card_number_comparison_is_case_and_whitespace_insensitive(self):
        pool = CardPool()
        pool.add_card(card("b", "back", card_number=" RC-12 "))
        match = pool.add_card(card("f", "front", card_number="rc-12"))
        assert match is not None
        assert match.score == CARD_NUMBER_EXACT_SCORE

    def test_card_number_ordering_dominates_every_other_signal_combined(self):
        # The weight gaps, not the absolute values, are what the port preserves.
        assert CARD_NUMBER_EXACT_SCORE > PLAYER_EXACT_SCORE + TEAM_EXACT_SCORE
        assert PLAYER_EXACT_SCORE > PLAYER_FUZZY_SCORE
        assert PLAYER_FUZZY_SCORE > TEAM_FUZZY_SCORE
        assert TEAM_EXACT_SCORE > TEAM_FUZZY_SCORE


class TestAcceptThreshold:
    def test_weakest_accepted_signal_sits_exactly_on_the_threshold(self):
        assert (
            min(
                CARD_NUMBER_EXACT_SCORE,
                PLAYER_EXACT_SCORE,
                PLAYER_FUZZY_SCORE,
                TEAM_EXACT_SCORE,
                TEAM_FUZZY_SCORE,
            )
            == MATCH_ACCEPT_THRESHOLD
        )

    def test_a_threshold_scoring_candidate_is_accepted(self):
        pool = CardPool()
        pool.add_card(card("b", "back", team="Los Angeles Dodgers"))
        match = pool.add_card(card("f", "front", team="Dodgers", player="Walker Buehler"))
        assert match is not None
        assert match.score == TEAM_FUZZY_SCORE

    def test_zero_scoring_candidates_are_not_paired(self):
        # Both carry identity, so the side-only fallback is also blocked.
        pool = CardPool()
        pool.add_card(card("b", "back", team="Chiefs"))
        assert pool.add_card(card("f", "front", team="Dodgers")) is None
        assert pool.size == 2


class TestPlayerDisagreementHardReject:
    """A disagreeing player name is decisive — never a mere penalty."""

    def test_disagreement_beats_a_coincidentally_equal_card_number(self):
        # 2000 points of card-number agreement on the table; the port must
        # still refuse. Card numbers misread off fronts (jersey numbers,
        # copyright years) are exactly how unrelated cards used to pair.
        pool = CardPool()
        pool.add_card(card("b", "back", player="Clayton Kershaw", card_number="25"))
        assert pool.add_card(card("f", "front", player="Walker Buehler", card_number="25")) is None
        assert pool.size == 2

    def test_the_same_card_number_does_pair_when_no_player_contradicts_it(self):
        # Control for the test above: the card number really was worth 2000,
        # so the rejection above came from the player check and nothing else.
        pool = CardPool()
        pool.add_card(card("b", "back", player="Clayton Kershaw", card_number="25"))
        match = pool.add_card(card("f", "front", card_number="25"))
        assert match is not None
        assert match.score == CARD_NUMBER_EXACT_SCORE

    def test_rejection_does_not_block_a_different_valid_candidate(self):
        pool = CardPool()
        pool.add_card(card("wrong", "back", player="Clayton Kershaw", card_number="25"))
        pool.add_card(card("right", "back", player="Walker Buehler"))
        match = pool.add_card(card("f", "front", player="Walker Buehler", card_number="25"))
        assert match is not None
        assert match.back.key == "right"

    def test_disagreement_also_blocks_team_agreement(self):
        pool = CardPool()
        pool.add_card(card("b", "back", player="Clayton Kershaw", team="Dodgers"))
        assert pool.add_card(card("f", "front", player="Walker Buehler", team="Dodgers")) is None


class TestSurnameOnlyFront:
    def test_surname_only_front_pairs_with_a_full_name_back(self):
        pool = CardPool()
        pool.add_card(card("b", "back", player="Walker Buehler"))
        match = pool.add_card(card("f", "front", player="BUEHLER"))
        assert match is not None
        assert match.confidence == "fuzzy"
        assert match.score == PLAYER_FUZZY_SCORE

    def test_a_surname_only_front_still_rejects_a_different_surname(self):
        pool = CardPool()
        pool.add_card(card("b", "back", player="Clayton Kershaw"))
        assert pool.add_card(card("f", "front", player="BUEHLER")) is None


class TestSideOnlyFallback:
    def test_pairs_two_identity_free_cards_when_only_one_candidate_exists(self):
        pool = CardPool()
        pool.add_card(PoolCard(key="b", side="back"))
        match = pool.add_card(PoolCard(key="f", side="front"))
        assert match is not None
        assert match.confidence == "side-only"
        assert match.score == 0
        assert match.front.key == "f"
        assert match.back.key == "b"

    def test_blocked_when_more_than_one_candidate_exists(self):
        pool = CardPool()
        pool.add_card(PoolCard(key="b1", side="back"))
        pool.add_card(PoolCard(key="b2", side="back"))
        assert pool.add_card(PoolCard(key="f", side="front")) is None

    def test_blocked_when_the_new_card_has_identity(self):
        pool = CardPool()
        pool.add_card(PoolCard(key="b", side="back"))
        assert pool.add_card(card("f", "front", player="Walker Buehler")) is None

    def test_blocked_when_the_pooled_card_has_identity(self):
        pool = CardPool()
        pool.add_card(card("b", "back", team="Dodgers"))
        assert pool.add_card(PoolCard(key="f", side="front")) is None


class TestInsertionOrderTieBreak:
    """Distinct players keep the two candidates from colliding as one card,
    while the identity-free front leaves the team as the only scoring signal —
    so both candidates tie at TEAM_EXACT_SCORE."""

    def test_ties_keep_the_first_offered_candidate(self):
        # `best_score` starts at 0 with a strict `>`, so the first candidate
        # offered wins a tie. Python dicts iterate in insertion order, which is
        # what makes that reproducible — the TS relied on `Map` for the same.
        pool = CardPool()
        pool.add_card(card("first", "back", team="Dodgers", player="Walker Buehler"))
        pool.add_card(card("second", "back", team="Dodgers", player="Clayton Kershaw"))
        match = pool.add_card(card("f", "front", team="Dodgers"))
        assert match is not None
        assert match.back.key == "first"

    def test_reversing_the_offer_order_reverses_the_winner(self):
        pool = CardPool()
        pool.add_card(card("second", "back", team="Dodgers", player="Clayton Kershaw"))
        pool.add_card(card("first", "back", team="Dodgers", player="Walker Buehler"))
        match = pool.add_card(card("f", "front", team="Dodgers"))
        assert match is not None
        assert match.back.key == "second"

    def test_a_strictly_better_candidate_still_wins_from_second_place(self):
        pool = CardPool()
        pool.add_card(card("weak", "back", team="Dodgers", player="Clayton Kershaw"))
        pool.add_card(
            card("strong", "back", team="Dodgers", player="Walker Buehler", card_number="25")
        )
        match = pool.add_card(card("f", "front", team="Dodgers", card_number="25"))
        assert match is not None
        assert match.back.key == "strong"
        assert match.score == TEAM_EXACT_SCORE + CARD_NUMBER_EXACT_SCORE


class TestPostPairMerge:
    def test_player_and_team_prefer_the_front(self):
        pool = CardPool()
        pool.add_card(card("b", "back", player="Walker Buehler", team="Los Angeles Dodgers"))
        match = pool.add_card(card("f", "front", player="BUEHLER", team="Dodgers"))
        assert match is not None
        assert match.player == "BUEHLER"
        assert match.team == "Dodgers"

    def test_player_and_team_fall_back_to_the_back(self):
        # An identity-free front — a photo the model read nothing off — paired
        # on the card number alone still yields a fully identified card.
        pool = CardPool()
        pool.add_card(card("b", "back", player="Walker Buehler", team="Dodgers", card_number="25"))
        match = pool.add_card(card("f", "front", card_number="25"))
        assert match is not None
        assert match.player == "Walker Buehler"
        assert match.team == "Dodgers"

    def test_card_number_comes_from_the_back_only(self):
        # A card number on a front is a misread, so it never wins the merge —
        # even when the back has none at all.
        pool = CardPool()
        pool.add_card(card("b", "back", player="Walker Buehler"))
        match = pool.add_card(card("f", "front", player="Walker Buehler", card_number="99"))
        assert match is not None
        assert match.card_number is None

    def test_card_number_from_the_back_survives(self):
        pool = CardPool()
        pool.add_card(card("b", "back", player="Walker Buehler", card_number="25"))
        match = pool.add_card(card("f", "front", player="Walker Buehler", card_number="99"))
        assert match is not None
        assert match.card_number == "25"

    def test_front_and_back_are_assigned_by_side_not_arrival(self):
        pool = CardPool()
        pool.add_card(card("arrived-first", "front", player="Walker Buehler"))
        match = pool.add_card(card("arrived-second", "back", player="Walker Buehler"))
        assert match is not None
        assert match.front.key == "arrived-first"
        assert match.back.key == "arrived-second"


class TestSameCardIdentity:
    def test_agreeing_players_are_the_same_card(self):
        assert same_card_identity(card("a", player="BUEHLER"), card("b", player="Walker Buehler"))

    def test_disagreeing_players_are_decisive_over_an_equal_card_number(self):
        a = card("a", player="Walker Buehler", card_number="25")
        b = card("b", player="Clayton Kershaw", card_number="25")
        assert same_card_identity(a, b) is False

    def test_card_number_is_a_fallback_when_a_player_is_missing(self):
        assert same_card_identity(card("a", card_number="25"), card("b", card_number="25"))

    def test_differing_card_numbers_fall_through_to_the_team_check(self):
        a = card("a", card_number="25", team="Dodgers")
        b = card("b", card_number="99", team="Los Angeles Dodgers")
        assert same_card_identity(a, b) is True

    def test_differing_card_numbers_with_no_team_are_not_the_same_card(self):
        assert same_card_identity(card("a", card_number="25"), card("b", card_number="99")) is False

    def test_team_is_the_last_fallback(self):
        assert same_card_identity(card("a", team="Dodgers"), card("b", team="Los Angeles Dodgers"))

    def test_nothing_in_common_is_not_the_same_card(self):
        assert same_card_identity(card("a", team="Chiefs"), card("b", team="Dodgers")) is False


class TestSameSideCollision:
    def test_same_image_evicts_the_stale_entry(self):
        pool = CardPool(hash_image=hasher_from({"old": HASH_A, "new": HASH_NEAR}))
        pool.add_card(card("old", "back", player="Walker Buehler"))
        assert pool.add_card(card("new", "back", player="Walker Buehler")) is None
        assert [c.key for c in pool.entries()] == ["new"]
        assert pool.entries()[0].side == "back"

    def test_different_image_flips_the_incoming_side_and_pairs(self):
        # The mis-classification case: two different images both labelled
        # "back". The incoming one is flipped rather than clobbering the pooled
        # image, and the flip immediately lets the two pair.
        pool = CardPool(hash_image=hasher_from({"pooled": HASH_A, "incoming": HASH_FAR}))
        pool.add_card(card("pooled", "back", player="Walker Buehler"))
        match = pool.add_card(card("incoming", "back", player="Walker Buehler"))
        assert match is not None
        assert match.front.key == "incoming"
        assert match.front.side == "front"
        assert match.back.key == "pooled"
        assert pool.size == 0

    def test_without_a_hasher_the_newest_card_wins(self):
        pool = CardPool()
        pool.add_card(card("old", "back", player="Walker Buehler"))
        assert pool.add_card(card("new", "back", player="Walker Buehler")) is None
        assert [c.key for c in pool.entries()] == ["new"]

    def test_an_unhashable_image_degrades_to_newer_wins(self):
        pool = CardPool(hash_image=hasher_from({"old": HASH_A, "new": None}))
        pool.add_card(card("old", "back", player="Walker Buehler"))
        assert pool.add_card(card("new", "back", player="Walker Buehler")) is None
        assert [c.key for c in pool.entries()] == ["new"]

    def test_a_raising_hasher_degrades_to_newer_wins(self):
        def boom(_key: str) -> int | None:
            raise OSError("cannot read image")

        pool = CardPool(hash_image=boom)
        pool.add_card(card("old", "back", player="Walker Buehler"))
        assert pool.add_card(card("new", "back", player="Walker Buehler")) is None
        assert [c.key for c in pool.entries()] == ["new"]

    def test_hashes_are_memoised_on_the_card(self):
        calls: list[str] = []

        def counting(key: str) -> int | None:
            calls.append(key)
            return HASH_A

        pool = CardPool(hash_image=counting)
        pool.add_card(card("old", "back", player="Walker Buehler"))
        pool.add_card(card("new", "back", player="Walker Buehler"))
        assert pool.entries()[0].image_hash == HASH_A
        # Second collision on the surviving card must not re-hash it.
        before = len(calls)
        pool.add_card(card("newer", "back", player="Walker Buehler"))
        assert calls[before:] == ["newer"]

    def test_identity_free_cards_skip_collision_resolution(self):
        pool = CardPool(hash_image=hasher_from({"a": HASH_A, "b": HASH_FAR}))
        pool.add_card(PoolCard(key="a", side="back"))
        pool.add_card(PoolCard(key="b", side="back"))
        assert pool.size == 2

    def test_cards_of_different_sides_do_not_collide(self):
        pool = CardPool(hash_image=hasher_from({"f": HASH_A, "b": HASH_FAR}))
        pool.add_card(card("b", "back", player="Walker Buehler"))
        match = pool.add_card(card("f", "front", player="Walker Buehler"))
        assert match is not None
        assert match.front.key == "f"

    def test_a_card_never_collides_with_its_own_key(self):
        # Re-offering the same key (a retried image, say) must not read the
        # pooled copy of itself as a collision and flip its own side.
        pool = CardPool(hash_image=hasher_from({"a": HASH_A}))
        pool.add_card(card("a", "back", player="Walker Buehler"))
        assert pool.add_card(card("a", "back", player="Walker Buehler")) is None
        assert pool.size == 1
        assert pool.entries()[0].side == "back"

    def test_a_non_colliding_same_side_card_is_left_alone(self):
        pool = CardPool(hash_image=hasher_from({"a": HASH_A, "b": HASH_FAR}))
        pool.add_card(card("a", "back", player="Walker Buehler"))
        pool.add_card(card("b", "back", player="Clayton Kershaw"))
        assert [c.key for c in pool.entries()] == ["a", "b"]
