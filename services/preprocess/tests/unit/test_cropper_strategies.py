"""Unit tests for the public strategy registry/runner helpers in app.cropper.

These primitives back both the cascade in `crop()` and the new `/crop`
endpoint, so they're tested directly here rather than only through HTTP.
"""

from __future__ import annotations

import logging

import pytest

from app import cropper
from app.cropper import (
    STRATEGY_NAMES,
    UnknownStrategyError,
    resolve_strategy_identifier,
    run_strategy,
    run_strategy_capturing,
)


class TestStrategyNames:
    def test_matches_internal_strategies_list(self):
        assert STRATEGY_NAMES == ("pil_trim_dark", "pil_trim_light", "sam", "haiku_bbox")

    def test_is_a_tuple(self):
        # Tuple, not list — STRATEGY_NAMES is meant to be the canonical, immutable order.
        assert isinstance(STRATEGY_NAMES, tuple)


class TestResolveStrategyIdentifier:
    @pytest.mark.parametrize("name", list(STRATEGY_NAMES))
    def test_accepts_valid_names(self, name):
        assert resolve_strategy_identifier(name) == name

    @pytest.mark.parametrize("idx,expected", list(enumerate(STRATEGY_NAMES)))
    def test_accepts_int_index(self, idx, expected):
        assert resolve_strategy_identifier(idx) == expected

    @pytest.mark.parametrize("idx,expected", list(enumerate(STRATEGY_NAMES)))
    def test_accepts_numeric_string_index(self, idx, expected):
        assert resolve_strategy_identifier(str(idx)) == expected

    def test_unknown_name_raises(self):
        with pytest.raises(UnknownStrategyError, match="unknown strategy"):
            resolve_strategy_identifier("not_a_real_strategy")

    def test_out_of_range_int_raises(self):
        with pytest.raises(UnknownStrategyError, match="out of range"):
            resolve_strategy_identifier(99)

    def test_out_of_range_numeric_string_raises(self):
        with pytest.raises(UnknownStrategyError, match="out of range"):
            resolve_strategy_identifier("99")

    def test_negative_int_raises(self):
        with pytest.raises(UnknownStrategyError, match="out of range"):
            resolve_strategy_identifier(-1)

    def test_negative_numeric_string_raises(self):
        with pytest.raises(UnknownStrategyError, match="out of range"):
            resolve_strategy_identifier("-1")

    def test_bool_rejected(self):
        # bool is an int subclass; we explicitly reject it because True == 1
        # would silently resolve to STRATEGY_NAMES[1] which is surprising.
        with pytest.raises(UnknownStrategyError):
            resolve_strategy_identifier(True)

    def test_non_numeric_junk_raises(self):
        with pytest.raises(UnknownStrategyError, match="unknown strategy"):
            resolve_strategy_identifier("abc123")


class TestRunStrategy:
    def test_returns_bytes_when_strategy_returns_bytes(self, monkeypatch):
        monkeypatch.setattr("app.cropper.sam.sam_crop", lambda _b: b"cropped")
        assert run_strategy("sam", b"in") == b"cropped"

    def test_returns_none_when_strategy_returns_none(self, monkeypatch):
        monkeypatch.setattr("app.cropper.sam.sam_crop", lambda _b: None)
        assert run_strategy("sam", b"in") is None

    def test_returns_none_when_strategy_raises(self, monkeypatch, caplog):
        def _boom(_b):
            raise RuntimeError("kaboom")

        monkeypatch.setattr("app.cropper.sam.sam_crop", _boom)

        with caplog.at_level(logging.WARNING, logger=cropper.__name__):
            assert run_strategy("sam", b"in") is None

        # Logger formats with %s — check the rendered message includes the
        # strategy name and the exception's str() output.
        assert any(
            "sam" in rec.getMessage() and "kaboom" in rec.getMessage() for rec in caplog.records
        )

    def test_unknown_name_raises(self):
        with pytest.raises(UnknownStrategyError):
            run_strategy("not_a_strategy", b"in")


class TestRunStrategyCapturing:
    def test_success_returns_bytes_and_none_error(self, monkeypatch):
        monkeypatch.setattr("app.cropper.haiku_bbox.haiku_bbox_crop", lambda _b: b"crop")
        produced, err = run_strategy_capturing("haiku_bbox", b"in")
        assert produced == b"crop"
        assert err is None

    def test_none_return_is_distinct_from_exception(self, monkeypatch):
        monkeypatch.setattr("app.cropper.haiku_bbox.haiku_bbox_crop", lambda _b: None)
        produced, err = run_strategy_capturing("haiku_bbox", b"in")
        assert produced is None
        assert err is None  # critical: ran cleanly, just produced nothing

    def test_exception_returns_none_bytes_and_class_name(self, monkeypatch):
        class CustomBoomError(RuntimeError):
            pass

        def _boom(_b):
            raise CustomBoomError("nope")

        monkeypatch.setattr("app.cropper.haiku_bbox.haiku_bbox_crop", _boom)
        produced, err = run_strategy_capturing("haiku_bbox", b"in")
        assert produced is None
        assert err == "CustomBoomError"
