"""Unit tests for app.pairing.names.

Covers: normalisation ordering (suffix stripping before punctuation stripping,
which is what keeps "Jr." working), the ported standalone-`v` quirk, last-name
extraction, and every rung of the player-name ladder — exact, surname-only,
single initial, truncated-first-name prefix with its 2-character floor, and the
disagreement case. Plus team matching by equality and by containment.
"""

from __future__ import annotations

import pytest

from app.pairing.names import (
    MIN_PREFIX_CHARS,
    NameMatch,
    last_name,
    normalize_player_name,
    player_names_match,
    team_names_match,
)


class TestNormalizePlayerName:
    def test_lowercases(self):
        assert normalize_player_name("Walker BUEHLER") == "walker buehler"

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Ken Griffey Jr.", "ken griffey"),
            ("Ken Griffey Jr", "ken griffey"),
            ("Cal Ripken Sr.", "cal ripken"),
            ("Robert Griffin III", "robert griffin"),
            ("Robert Griffin II", "robert griffin"),
            ("Robert Griffin IV", "robert griffin"),
        ],
    )
    def test_strips_generational_suffixes(self, raw, expected):
        assert normalize_player_name(raw) == expected

    def test_suffix_stripping_precedes_punctuation_stripping(self):
        # The suffix pattern absorbs its own trailing period. If punctuation
        # were stripped first the ordering assumption in the port would be
        # inverted, so this pins the observable outcome of the source order.
        assert normalize_player_name("Ken Griffey Jr.") == "ken griffey"

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("P. Mahomes", "p mahomes"),
            ("Shaquille O'Neal", "shaquille oneal"),
            ("Jean-Luc Picard", "jeanluc picard"),
        ],
    )
    def test_strips_punctuation(self, raw, expected):
        assert normalize_player_name(raw) == expected

    def test_collapses_whitespace_and_trims(self):
        assert normalize_player_name("  Walker   Buehler  ") == "walker buehler"

    def test_standalone_v_quirk_is_ported_verbatim(self):
        # `\b(...|v)\b` strips a lone `v` from ANYWHERE in the name, not just a
        # trailing Roman-numeral suffix. Ported deliberately; documented in
        # names.py. This test exists to make the quirk a decision, not a bug.
        assert normalize_player_name("Bobby V") == "bobby"

    def test_v_inside_a_word_is_untouched(self):
        assert normalize_player_name("Vlad Guerrero") == "vlad guerrero"

    def test_empty_string(self):
        assert normalize_player_name("") == ""


class TestLastName:
    def test_multi_part(self):
        assert last_name("walker buehler") == "buehler"

    def test_single_part(self):
        assert last_name("buehler") == "buehler"

    def test_three_parts_takes_the_last(self):
        assert last_name("jean luc picard") == "picard"


class TestPlayerNamesMatch:
    def test_identical_names_are_exact(self):
        assert player_names_match("Walker Buehler", "Walker Buehler") == NameMatch(
            match=True, exact=True
        )

    def test_case_and_suffix_differences_still_exact(self):
        # Both normalise to the same string, so this is an exact match.
        assert player_names_match("KEN GRIFFEY JR.", "Ken Griffey") == NameMatch(
            match=True, exact=True
        )

    def test_surname_only_front_matches_full_name_back(self):
        # The headline fix from the source commit: a front printing only
        # "BUEHLER" must pair with a back reading "Walker Buehler".
        result = player_names_match("BUEHLER", "Walker Buehler")
        assert result.match is True
        assert result.exact is False

    def test_surname_only_match_is_symmetric(self):
        result = player_names_match("Walker Buehler", "BUEHLER")
        assert result.match is True
        assert result.exact is False

    @pytest.mark.parametrize(
        "a,b",
        [
            ("P. Mahomes", "Patrick Mahomes"),
            ("Patrick Mahomes", "P. Mahomes"),
        ],
    )
    def test_single_initial_matches_full_first_name(self, a, b):
        result = player_names_match(a, b)
        assert result.match is True
        assert result.exact is False

    def test_single_initial_that_does_not_prefix_is_rejected(self):
        assert player_names_match("T. Mahomes", "Patrick Mahomes").match is False

    @pytest.mark.parametrize(
        "a,b",
        [
            ("Rob Gronkowski", "Robert Gronkowski"),
            ("Pat Mahomes", "Patrick Mahomes"),
            ("Robert Gronkowski", "Rob Gronkowski"),
        ],
    )
    def test_truncated_first_name_prefix_matches(self, a, b):
        result = player_names_match(a, b)
        assert result.match is True
        assert result.exact is False

    def test_prefix_floor_is_driven_by_the_production_constant(self):
        # A first name shorter than the floor may only match through the
        # single-initial rung, which requires a genuine prefix.
        shorter = "x" * (MIN_PREFIX_CHARS - 1)
        assert player_names_match(f"{shorter} Smith", "Adam Smith").match is False

    def test_different_surnames_never_match(self):
        assert player_names_match("Walker Buehler", "Walker Kershaw").match is False

    def test_different_first_names_with_same_surname_do_not_match(self):
        assert player_names_match("Walker Buehler", "Clayton Buehler").match is False


class TestTeamNamesMatch:
    def test_identical_is_exact(self):
        assert team_names_match("Dodgers", "Dodgers") == NameMatch(match=True, exact=True)

    def test_case_and_whitespace_insensitive_exact(self):
        assert team_names_match("  DODGERS ", "dodgers") == NameMatch(match=True, exact=True)

    @pytest.mark.parametrize(
        "a,b",
        [
            ("Chiefs", "Kansas City Chiefs"),
            ("Kansas City Chiefs", "Chiefs"),
        ],
    )
    def test_containment_is_a_fuzzy_match(self, a, b):
        result = team_names_match(a, b)
        assert result.match is True
        assert result.exact is False

    def test_unrelated_teams_do_not_match(self):
        assert team_names_match("Chiefs", "Dodgers").match is False
