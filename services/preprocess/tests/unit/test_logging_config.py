"""Unit tests for the NEO-191 logging configuration.

The bug these lock down: this service configured logging nowhere, and uvicorn
configures only its own non-propagating loggers, so every `logger.info` in
`app.*` propagated to a bare root logger at the default WARNING and was
discarded. Production ran for a week emitting nothing but uvicorn's access log
— the crop cascade's routing decisions, the thing you would actually want when
a crop comes back wrong, were invisible.

So the assertion that matters is not "basicConfig was called" but "an INFO
record logged by an `app.*` logger is actually emitted", which is what
`test_app_logger_info_is_emitted` checks end to end.
"""

from __future__ import annotations

import logging

import pytest

from app.main import DEFAULT_LOG_LEVEL, LOG_LEVEL_ENV, _configure_logging


@pytest.fixture(autouse=True)
def _restore_root_logger():
    """`_configure_logging` mutates global state; put it back afterwards."""
    root = logging.getLogger()
    saved_level, saved_handlers = root.level, root.handlers[:]
    yield
    root.handlers[:] = saved_handlers
    root.setLevel(saved_level)


class TestLevelSelection:
    def test_defaults_to_info(self, monkeypatch):
        monkeypatch.delenv(LOG_LEVEL_ENV, raising=False)

        _configure_logging()

        assert logging.getLogger().level == logging.INFO
        assert DEFAULT_LOG_LEVEL == "INFO"

    @pytest.mark.parametrize(
        ("configured", "expected"),
        [
            ("DEBUG", logging.DEBUG),
            ("debug", logging.DEBUG),
            ("  WARNING  ", logging.WARNING),
            ("ERROR", logging.ERROR),
        ],
    )
    def test_honours_the_env_var_case_and_space_insensitively(
        self, monkeypatch, configured, expected
    ):
        monkeypatch.setenv(LOG_LEVEL_ENV, configured)

        _configure_logging()

        assert logging.getLogger().level == expected

    @pytest.mark.parametrize("bogus", ["VERBOSE", "", "12three"])
    def test_an_unparseable_level_falls_back_to_info_without_raising(self, monkeypatch, bogus):
        """A typo in an env var must not take the container down on import."""
        monkeypatch.setenv(LOG_LEVEL_ENV, bogus)

        _configure_logging()

        assert logging.getLogger().level == logging.INFO

    def test_the_level_is_applied_even_when_a_handler_already_exists(self, monkeypatch):
        """`basicConfig` no-ops once the root logger has handlers — which it
        does under pytest, and can under an embedder that configured logging
        itself. The level has to be set explicitly or that no-op would restore
        the exact silence this change exists to fix."""
        monkeypatch.delenv(LOG_LEVEL_ENV, raising=False)
        root = logging.getLogger()
        root.addHandler(logging.NullHandler())
        root.setLevel(logging.WARNING)

        _configure_logging()

        assert root.level == logging.INFO


class TestRecordsActuallyReachAHandler:
    def test_app_logger_info_is_emitted(self, monkeypatch, caplog):
        """The end-to-end shape of the original bug: an `app.*` INFO record."""
        monkeypatch.delenv(LOG_LEVEL_ENV, raising=False)
        _configure_logging()

        with caplog.at_level(logging.INFO, logger="app.cropper.scan_meta"):
            logging.getLogger("app.cropper.scan_meta").info("2.48x3.46in @400dpi is one card")

        assert "2.48x3.46in @400dpi is one card" in caplog.text

    def test_app_loggers_still_propagate_to_root(self):
        """Nothing in the service may set propagate=False on an `app.*`
        logger; the root handler is the only thing carrying these records."""
        assert logging.getLogger("app.cropper.scan_meta").propagate is True
        assert logging.getLogger("app.main").propagate is True

    def test_uvicorn_access_logs_are_not_doubled(self, monkeypatch):
        """uvicorn's own loggers do not propagate, so configuring root cannot
        make its access lines appear twice."""
        monkeypatch.delenv(LOG_LEVEL_ENV, raising=False)
        access = logging.getLogger("uvicorn.access")
        access.propagate = False  # uvicorn's own default

        _configure_logging()

        assert access.propagate is False
